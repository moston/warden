# Lokalny Stack Observability — Wariant Grafana + APM

> **Alternatywa do**: [`stack-proposal.md`](stack-proposal.md) (Grafana Tempo + Loki, APM opcjonalne)
> oraz [`stack-proposal-signoz.md`](stack-proposal-signoz.md) (SigNoz jako osobne APM).
>
> **Główna różnica**: jedno narzędzie — **Grafana** — pełni rolę UI dla metryk, logów,
> traces **i APM** (RED, service map, error tracking). Nie ma drugiego UI ani ClickHouse.
> APM powstaje natywnie z trace'ów przez **Tempo metrics-generator**, a jeden kolektor
> **Grafana Alloy** zastępuje OTel Collector + Promtail.
>
> **Decyzja bazowa**: produkcja idzie w Grafanę. Ten wariant daje **identyczną
> konfigurację prod/local** — to samo narzędzie, ta sama instrumentacja OTel, te same
> dashboardy. Odpada argument „poznać SigNoz przed produkcją".

---

## Kontekst i cel

(Identyczny jak w wariancie bazowym — patrz `stack-proposal.md`)

Wariant Grafana + APM adresuje te same problemy:

| Kategoria | Przykład |
|-----------|---------|
| Slow queries | Zapytanie na nieindeksowanej kolumnie pod obciążeniem |
| Brakujące indeksy | Full table scan przy współbieżnych żądaniach |
| Regresje per endpoint | Endpoint 3x wolniejszy po dodaniu nowej logiki |
| Resource exhaustion | Wyczerpanie connection pool MySQL przy 50 concurrent users |

---

## Środowisko: Warden + środowiska dynamiczne

Takie same założenia jak w wariancie bazowym — globalny stack observability jako
usługa Warden, rozróżnianie środowisk przez system labeli.

### Model wdrożenia: globalny stack vs per-env

> **Decyzja**: cały stack observability — **łącznie z Grafana Alloy** — to **jedna
> globalna instancja** na sieci `warden` (jak Traefik), a **nie** komponent stawiany
> per środowisko. Przy wielu równoległych środowiskach postawienie stacku per-env
> byłoby niewykonalne zasobowo i uniemożliwiłoby porównywanie wersji.

```
GLOBALNE (jedna instancja, sieć `warden`, jak Traefik):
  Grafana, Prometheus, Loki, Tempo, Grafana Alloy, PMM

PER-ENV (lekkie, jedzie razem ze środowiskiem — ŻADNEGO komponentu observability):
  - OTel SDK w aplikacji (Magento/Nuxt/...) — push traces do globalnego Alloy
  - Docker labels na kontenerach (observability.service itd.)
  - zmienna ENV_NAME / deployment.environment identyfikująca środowisko
```

**Dlaczego globalnie:**
- **Zasoby** — Prometheus + Loki + Tempo + Grafana + Alloy razy N środowisk jest nie
  do utrzymania lokalnie; jedna instancja obsługuje wszystkie równolegle.
- **Porównywanie wersji** — sens stacku (master vs release-2-5 na jednym wykresie,
  jeden Service Graph, jedno QAN) wymaga, by dane ze wszystkich środowisk trafiały do
  **jednego** backendu. Per-env dałoby N nieporównywalnych Grafan.
- **Zbieżność z produkcją** — na prod również jeden stack obserwuje wiele instancji.

**Jak globalny stack widzi wiele środowisk** — bez rekonfiguracji przy każdym nowym env:
- **Alloy** i **Prometheus** mają dostęp do `docker.sock` i przez `discovery.docker` /
  `docker_sd_configs` same wykrywają kontenery wszystkich środowisk.
- Aplikacje push'ują traces na stały endpoint globalnego Alloy (OTLP `:4318`).
- Rozróżnienie idzie przez labele / `deployment.environment`; w Grafanie filtruje się
  zmienną `$env_name`.
- Jedyne akcje przy starcie środowiska: rejestracja bazy w PMM i ustawienie `ENV_NAME`
  dla instrumentacji (obejmuje to Faza 4 — integracja z `b/dev-env`).

---

## Proponowany stack

### Podział odpowiedzialności

```
Grafana         ← JEDNO UI: metryki + logi + traces + APM (RED, service map, error tracking)
Prometheus      ← metryki infra + span_metrics/service_graph generowane z trace'ów
Loki            ← logi aplikacji i kontenerów
Tempo           ← traces + metrics-generator (RED + service graph → Prometheus)
Grafana Alloy   ← jeden kolektor: OTLP (traces) + logi (filelog/docker) — zastępuje OTel Collector + Promtail
Percona PMM     ← query analytics MySQL
k6              ← testy obciążeniowe
```

**Co odpada względem wariantu SigNoz**: SigNoz stack (frontend, query-service,
signoz-otel-collector), ClickHouse (–2-4 GB RAM), drugie UI.

**Co się upraszcza względem wariantu bazowego**: OTel Collector + Promtail → jeden
**Grafana Alloy**. Tempo dostaje włączony metrics-generator, przez co APM jest
natywne w Grafanie zamiast „opcjonalne, wymaga pracy".

---

### 1. Grafana — jedno UI dla wszystkiego

Grafana jest jednocześnie warstwą wizualizacji metryk/logów i **backendem APM**.
Cztery mechanizmy zamieniają Tempo w pełne APM widoczne w Grafanie:

#### a) Tempo metrics-generator — RED z trace'ów

Tempo z włączonym `metrics_generator` produkuje z każdego spana metryki RED
(Rate, Errors, Duration) oraz metryki service-graph i remote-write'uje je do Prometheusa.
To jest serce „APM" — automatyczne metryki per serwis i per endpoint bez pisania ich ręcznie.

```yaml
# tempo.yaml (fragment)
metrics_generator:
  registry:
    external_labels:
      source: tempo
  storage:
    path: /var/tempo/generator/wal
    remote_write:
      - url: http://prometheus:9090/api/v1/write
        send_exemplars: true
  processor:
    span_metrics:                 # → traces_spanmetrics_* (RED per span)
      dimensions: [service.name, deployment.environment, http.route]
    service_graphs:               # → traces_service_graph_* (mapa zależności)
      dimensions: [service.name, deployment.environment]

overrides:
  defaults:
    metrics_generator:
      processors: [span-metrics, service-graphs]
```

#### b) Service Graph — automatyczna mapa serwisów

Data source Tempo ma natywną zakładkę **Service Graph** (node graph), zasilaną
metrykami `traces_service_graph_*`. Znika „ręczna konfiguracja service map"
z wariantu bazowego — mapa `magento → price-server → maptica` z latencją na
krawędziach powstaje sama.

#### c) Korelacja trace ↔ log ↔ metryka

- **trace → log**: konfiguracja `tracesToLogsV2` w data source Tempo — klik w span
  otwiera Loki przefiltrowane po `trace_id`. Wymaga, by instrumentacja wstrzykiwała
  `trace_id` do logów (OTel logging integration lub Monolog processor w Magento).
- **metryka → trace**: **exemplary** — punkt na wykresie latencji linkuje do
  konkretnego trace'a (`send_exemplars: true` powyżej). To przewaga tego wariantu
  nawet nad SigNoz, który koreluje z metrykami słabo.
- **log → trace**: `derivedFields` w data source Loki wyciąga `trace_id` z linii logu
  i tworzy link do Tempo.

```yaml
# grafana datasource: Tempo
jsonData:
  tracesToLogsV2:
    datasourceUid: loki
    filterByTraceID: true
    tags: [{ key: 'service.name', value: 'service' }]
  tracesToMetrics:
    datasourceUid: prometheus
  serviceMap:
    datasourceUid: prometheus
```

#### d) Widoki APM w Grafanie

Na bazie `traces_spanmetrics_*` dostajesz w Grafanie:
- listę serwisów z RED (rate / error rate / p50-p95-p99 latency),
- drill-down per endpoint (`http.route`),
- porównanie wersji przez zmienną `$env_name` (master vs release-2-5 na jednym wykresie),
- trace waterfall z klikalnym przejściem do logów i metryk.

> **Uwaga o zakresie**: dopracowana aplikacja „Application Observability" (płynny,
> APM-first UI z auto-detekcją serwisów) jest funkcją Grafana Cloud. W OSS odtwarzamy
> ją zestawem dashboardów (gotowe community dashboardy dla span-metrics istnieją) +
> zakładkami Service Graph / Span Metrics w data source. Funkcjonalnie pokrywa RED,
> service map i porównanie wersji; nie ma gotowego „error tracking" grupującego wyjątki
> tak jak SigNoz — to odtwarzamy zapytaniami po logach (`level=error`) i statusie spanów.

---

### 2. Grafana Alloy — jeden kolektor

Alloy (dystrybucja kolektora od Grafana Labs, następca Agenta) obsługuje w jednym
procesie to, co w wariancie bazowym robiły dwa osobne komponenty:

- **traces**: receiver OTLP (`:4317/:4318`) → Tempo,
- **logi**: `discovery.docker` + `loki.source.docker` (logi kontenerów) oraz
  `loki.source.file` (logi aplikacji Magento) → Loki,
- **wzbogacanie**: `otelcol.processor.resource` / relabeling dodaje `deployment.environment`
  i `service.name` na podstawie zmiennej `ENV_NAME` i Docker labels.

```alloy
// config.alloy (fragment)

// ── Traces: OTLP → Tempo ────────────────────────────────
otelcol.receiver.otlp "default" {
  grpc { endpoint = "0.0.0.0:4317" }
  http { endpoint = "0.0.0.0:4318" }
  output { traces = [otelcol.processor.resource.env.input] }
}

otelcol.processor.resource "env" {
  attributes {
    action = "insert"
    key    = "deployment.environment"
    value  = env("ENV_NAME")
  }
  output { traces = [otelcol.exporter.otlp.tempo.input] }
}

otelcol.exporter.otlp "tempo" {
  client { endpoint = "tempo:4317"  tls { insecure = true } }
}

// ── Logi kontenerów Docker → Loki ───────────────────────
discovery.docker "warden" {
  host = "unix:///var/run/docker.sock"
}

discovery.relabel "warden" {
  targets = discovery.docker.warden.targets
  rule {
    source_labels = ["__meta_docker_container_label_com_docker_compose_project"]
    target_label  = "env_name"
  }
  rule {
    source_labels = ["__meta_docker_container_label_com_docker_compose_service"]
    target_label  = "component"
  }
}

loki.source.docker "warden" {
  host       = "unix:///var/run/docker.sock"
  targets    = discovery.relabel.warden.output
  forward_to = [loki.write.default.receiver]
}

// ── Logi aplikacji Magento (file tailing) ───────────────
local.file_match "magento" {
  path_targets = [
    { __path__ = "/var/www/html/var/log/magento/exception.log", service = "magento" },
    { __path__ = "/var/www/html/var/log/magento/system.log",    service = "magento" },
  ]
}

loki.source.file "magento" {
  targets    = local.file_match.magento.targets
  forward_to = [loki.write.default.receiver]
}

loki.write "default" {
  endpoint { url = "http://loki:3100/loki/api/v1/push" }
}
```

**Źródła logów** (bez zmian względem wariantu bazowego):

```
var/log/magento/exception.log    → błędy aplikacji
var/log/magento/system.log       → logi systemowe
MySQL slow query log             → zapytania > 1s
PHP-FPM slow log                 → procesy > 5s
Nginx/Traefik access log         → 4xx/5xx, request timing
logi kontenerów Docker           → nginx, rabbitmq, redis (discovery.docker)
Price Server logs                → błędy kalkulacji
Maptica logs                     → błędy mapowania
```

#### Haczyk: logi plikowe wewnątrz kontenerów per-env

Globalny Alloy zbiera dane „z zewnątrz": traces (push OTLP) i logi kontenerów
(stdout/stderr przez `docker.sock`) działają bez dostępu do wnętrza środowiska.
Problemem są **pliki logów wewnątrz kontenerów per-env** (`exception.log`,
PHP-FPM slow log, MySQL slow query log) — leżą w systemie plików kontenera env,
a globalny Alloy nie sięga do nich przez sam `docker.sock`.

Strategia (od najlepszej):

1. **Przekierować logi Magento na stdout** — łapie je wtedy zwykła kolekcja logów
   kontenerów (`loki.source.docker`) i wszystko zostaje globalne. Najczystsze,
   najbliższe modelowi produkcyjnemu (12-factor). Preferowane tam, gdzie się da.
2. **Zamontować wolumeny logów env do globalnego Alloy** — Alloy tailuje pliki przez
   współdzielony mount (`loki.source.file`). Dla logów, których nie przełączysz na
   stdout (slow logi MySQL / PHP-FPM). Wiąże stack z układem katalogów środowiska.
3. **Mały per-env Alloy tylko do plików** — **odradzane**: reintrodukuje komponent
   per-env, którego cały ten model unika.

Rekomendacja: opcja 1 dla logów aplikacji Magento, opcja 2 dla slow logów MySQL/PHP-FPM.

---

### 3. Instrumentacja aplikacji (OpenTelemetry)

**Identyczna jak w wariantach bazowym i SigNoz** — to zaleta OTel: backend jest
wymienny bez dotykania kodu. Aplikacje wysyłają trace'y do Alloy (OTLP `:4318`).

```
PHP/Magento     → open-telemetry/opentelemetry-php (Composer) + auto-instrumentation (PDO, Redis, Guzzle)
Nuxt/Node.js    → @opentelemetry/sdk-node
Price Server    → natywne OTel SDK (Go/Python)
Maptica         → natywne OTel SDK
```

Trace waterfall po zebraniu danych (klikalny do logów przez `trace_id`):

```
Request POST /api/quotes  [total: 1.2s]  deployment.environment=release-2-5
  ├─ Magento: Auth middleware       [12ms]
  ├─ Magento: MySQL SELECT customer [340ms]  ← regresja względem master
  ├─ Price Server: calculate()      [180ms]
  ├─ Magento: Redis GET cache       [2ms]
  └─ Magento: MySQL INSERT quote    [780ms]  ← problem
```

> **Alternatywa mniej inwazyjna dla PHP**: **Tideways** (community edition) —
> dedykowany profiler PHP dla Magento. Rozważyć, jeśli auto-instrumentacja OTel PHP
> okaże się kosztowna w utrzymaniu (patrz `apm-comparison.md` — luka profilingu PHP).

---

### 4. Percona PMM — Query Analytics dla MySQL

Bez zmian względem wariantu bazowego. Szczegóły: [`stack-proposal.md`](stack-proposal.md#1-percona-pmm--query-analytics-dla-mysql).

---

### 5. k6 — Load Testing

Bez zmian względem wariantu bazowego. Szczegóły: [`stack-proposal.md`](stack-proposal.md#2-k6--load-testing).

Wyniki k6 trafiają do Prometheusa i są wizualizowane w tej samej Grafanie —
obok RED z APM, co pozwala korelować obciążenie z latencją endpointów w jednym widoku.

---

### 6. Prometheus — metryki infrastrukturalne + span metrics

Prometheus pełni podwójną rolę:
1. **metryki infra** — przez `docker_sd_configs` + exportery (jak w wariancie bazowym),
2. **backend dla APM** — odbiera `traces_spanmetrics_*` i `traces_service_graph_*`
   remote-write'owane z Tempo metrics-generator (potrzebne `--web.enable-remote-write-receiver`).

**Exportery per serwis** (bez zmian):

| Serwis | Exporter | Kluczowe metryki |
|--------|----------|-----------------|
| MariaDB | `mysql_exporter` | connections, queries/s, InnoDB |
| Redis | `redis_exporter` | hit rate, memory, evictions |
| PHP-FPM | `php-fpm_exporter` | active workers, queue |
| RabbitMQ | `rabbitmq_exporter` | queue depth, message rate |
| Nginx/Traefik | wbudowane metryki | req/s, 5xx rate, upstream latency |
| Node | `node_exporter` | CPU, RAM, disk I/O |

---

## Architektura całego stacku

```
Globalne usługi Warden (jedna instancja):

┌────────────────────────────────────────────────────────────────────┐
│                          Grafana :3000                             │
│   Metryki | Logi | Traces | APM (RED, Service Graph, waterfall)    │
│   Variables: $env_name | $service | $component                     │
│   Korelacja: metric ↔ trace (exemplary) ↔ log (trace_id)           │
└───────┬───────────────┬───────────────────┬───────────────────────┘
        │               │                   │
   Prometheus         Loki                Tempo
   :9090              :3100               :3200/:4317
        ▲               ▲                   │
        │ span_metrics  │                   │ metrics-generator
        │ service_graph │                   │ remote_write ──► Prometheus
        │ (remote_write)│                   │
        └───────────────┴─────── Grafana Alloy ──────────────┐
                        (OTLP :4318 traces + logi filelog/docker)
                                        │
    ────────────────────────────────────┼──────────────── sieć `warden`
                                        │
┌───────────────────────────────────────┴──────────────┐
│  Środowisko: magento2-master                          │
│  php-fpm | nginx | db | redis | rabbitmq | es         │
│  deployment.environment=master                         │
└───────────────────────────────────────────────────────┘
┌───────────────────────────────────────────────────────┐
│  Środowisko: magento2-release-2-5                     │
│  php-fpm | nginx | db | redis | rabbitmq | es         │
│  deployment.environment=release-2-5                   │
└───────────────────────────────────────────────────────┘

┌──────────────────────────┐
│   Percona PMM :8080       │   k6 --tag env_name=X → Prometheus → Grafana
│   Query Analytics MySQL  │
└──────────────────────────┘
```

---

## Porównanie wariantów

| Aspekt | Bazowy (Tempo+Loki) | SigNoz | **Grafana + APM** |
|--------|---------------------|--------|-------------------|
| Liczba komponentów | 7 | 5 | **6** (Alloy łączy OTel Collector + Promtail) |
| UI | jedno (Grafana) | dwa (SigNoz + Grafana) | **jedno (Grafana)** |
| Service map | ręczna konfiguracja | automatyczna | **automatyczna (metrics-generator)** |
| RED per endpoint | wymaga pracy | automatyczne | **automatyczne (span_metrics)** |
| Korelacja trace ↔ log | konfiguracja | natywna | konfiguracja (trace_id) |
| Korelacja trace ↔ metryka | natywna | ograniczona | **natywna (exemplary)** |
| Error tracking / grouping | brak | **dedykowany UI** | słabszy (query po logach/status spanu) |
| RAM overhead | niski | +2-4 GB (ClickHouse) | **niski (brak ClickHouse)** |
| Zbieżność z produkcją (prod = Grafana) | częściowa | wymaga migracji | **identyczna** |
| Próg wejścia | wyższy (7 komponentów) | niższy | średni (konfiguracja generatora + korelacji) |

**Wniosek**: przy założeniu, że **produkcja to Grafana**, ten wariant jest optymalny —
jedno narzędzie prod i local, ta sama instrumentacja i dashboardy, lżejszy od SigNoz
(brak ClickHouse) i domyka luki service-map/RED bez drugiego UI. Jedyny świadomy
kompromis to brak gotowego error-trackingu w stylu SigNoz.

---

## Plan wdrożenia

### Faza 1 — Fundament (1-2 dni)

- [ ] Docker Compose dla globalnego stacku (Grafana + Prometheus + Loki + Tempo + Alloy + PMM)
- [ ] Prometheus z `--web.enable-remote-write-receiver` (odbiór span metrics z Tempo)
- [ ] Percona PMM z ręczną rejestracją środowisk
- [ ] Pierwsze scenariusze k6 dla głównych flow Magento
- [ ] Weryfikacja że PMM QAN zbiera dane podczas testu k6

### Faza 2 — Metryki + logi (tydzień)

- [ ] Grafana Alloy: `discovery.docker` + `loki.source.docker` — logi ze wszystkich środowisk
- [ ] Alloy: `loki.source.file` dla logów aplikacji Magento
- [ ] Prometheus z `docker_sd_configs` — auto-discovery kontenerów Warden
- [ ] Docker labels w `docker-compose.observability.yml` per serwis
- [ ] Grafana: dashboardy community dla infrastruktury + zmienne `$env_name` / `$service`
- [ ] Integracja k6 → Prometheus → Grafana

### Faza 3 — APM przez Tempo metrics-generator (tydzień)

- [ ] Tempo: włączenie `metrics_generator` (span-metrics + service-graphs) z remote_write do Prometheusa
- [ ] Alloy: receiver OTLP + resource processor (`deployment.environment` z `ENV_NAME`)
- [ ] Data source Tempo w Grafanie: `serviceMap`, `tracesToLogsV2`, `tracesToMetrics`
- [ ] Data source Loki: `derivedFields` (log → trace po `trace_id`)
- [ ] Instrumentacja Magento: `open-telemetry/opentelemetry-php` + wstrzykiwanie `trace_id` do logów
- [ ] Instrumentacja Nuxt: `@opentelemetry/sdk-node`
- [ ] Instrumentacja Price Server + Maptica
- [ ] Dashboardy APM (RED per serwis/endpoint) + weryfikacja Service Graph i exemplarów

### Faza 4 — Integracja z `b/dev-env` (tydzień)

- [ ] Auto-rejestracja MySQL w PMM przy `b/dev-env create`
- [ ] Auto-ustawienie `ENV_NAME` dla Alloy przy starcie środowiska
- [ ] Standaryzacja Docker labels we wszystkich repozytoriach
- [ ] Auto-deregistracja przy `b/dev-env destroy`

### Faza 5 — Zbieżność z produkcją

- [ ] Wyodrębnienie wspólnej konfiguracji instrumentacji OTel (współdzielona prod/local)
- [ ] Współdzielone definicje dashboardów APM (provisioning jako kod)
- [ ] Ustalenie różnic prod/local (storage Tempo/Loki, retention, sampling)

---

## Najważniejsze metryki do śledzenia

| Metryka | Narzędzie | Alert gdy... |
|---------|-----------|-------------|
| MySQL slow queries/min | PMM | > baseline o 20% |
| p95 latencja endpointów | k6 + Grafana | > 3000ms |
| PHP-FPM active workers | Prometheus + Grafana | > 80% pool size |
| MySQL connections | Prometheus + Grafana | > 80% max_connections |
| Redis hit rate | Prometheus + Grafana | < 85% |
| 5xx error rate | Nginx/Traefik exporter | > 0.5% |
| DB query time p95 | PMM QAN | > 2x baseline |
| RabbitMQ queue depth | Prometheus + Grafana | > 1000 msgs |
| Błędy aplikacji (exception.log) | Loki | > threshold |
| Trace p95 per endpoint (RED) | Tempo span_metrics + Grafana | > 3000ms |
| Error rate per serwis (RED) | Tempo span_metrics + Grafana | > 0.5% |
| Price Server p95 latency | k6 + Grafana | > 500ms |

---

## Powiązane dokumenty

- [`stack-proposal.md`](stack-proposal.md) — wariant bazowy (Tempo + Loki, APM opcjonalne)
- [`stack-proposal-signoz.md`](stack-proposal-signoz.md) — wariant z SigNoz jako osobnym APM
- [`apm-comparison.md`](apm-comparison.md) — porównanie SigNoz / SkyWalking / Uptrace
