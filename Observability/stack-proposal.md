# Lokalny Stack Observability — Propozycja

## Kontekst i cel

Brak warstwy observability na produkcji uniemożliwia wczesne wykrywanie regresji
wydajnościowych. Celem jest zbudowanie lokalnego środowiska umożliwiającego:

- agregację logów ze wszystkich komponentów systemu
- monitoring metryk infrastrukturalnych w czasie rzeczywistym
- APM (Application Performance Monitoring) — śledzenie czasu per request/zapytanie
- testy obciążeniowe jako narzędzie do porównywania wersji (master vs release)

Główne kategorie problemów do wykrywania:

| Kategoria | Przykład |
|-----------|---------|
| Slow queries | Zapytanie na nieindeksowanej kolumnie pod obciążeniem |
| Brakujące indeksy | Full table scan przy współbieżnych żądaniach |
| Regresje per endpoint | Endpoint 3x wolniejszy po dodaniu nowej logiki |
| Resource exhaustion | Wyczerpanie connection pool MySQL przy 50 concurrent users |

---

## Kontekst środowiska: Warden + środowiska dynamiczne

System uruchomiony jest lokalnie na **Warden** — Docker orchestration tool dla Magento 2.
Aktualny stack per środowisko: MariaDB 10.6, Elasticsearch 8.17, RabbitMQ 4.0, Redis 7.4.

Rozwijana jest koncepcja **wielu równoległych środowisk** (Mode B z `tmp/dynamic-envs.md`):
każde środowisko to osobna instancja Warden z unikalnym `WARDEN_ENV_NAME`. Kontenery
każdego środowiska są prefiksowane nazwą projektu, np.:

```
magento2-master_php-fpm_1
magento2-master_nginx_1
magento2-master_db_1

magento2-release-2-5_php-fpm_1
magento2-release-2-5_nginx_1
magento2-release-2-5_db_1
```

Docelowo stack ma pokryć wszystkie serwisy ekosystemu: **Magento 2**, **Maptica**,
**Price Server** i kolejne — z pełnym widokiem cross-service dla akcji użytkownika.

### Kluczowe implikacje dla observability

> **Decyzja architektoniczna**: Stack observability musi być **globalną usługą Warden**
> (jak Traefik), a nie instancją per środowisko. Jeden zestaw narzędzi obserwuje
> wszystkie równoległe środowiska jednocześnie, rozróżniając je przez **system labeli**.

---

## System labeli — strategia wielośrodowiskowa

Każda metryka, log i trace musi nieść zestaw labeli identyfikujących źródło:

| Label | Przykładowe wartości | Opis |
|-------|---------------------|------|
| `env_name` | `master`, `release-2-5`, `feature-auth` | `WARDEN_ENV_NAME` środowiska |
| `service` | `magento`, `price-server`, `maptica`, `nuxt` | Serwis ekosystemu |
| `component` | `php-fpm`, `nginx`, `db`, `redis`, `rabbitmq` | Komponent infrastrukturalny |
| `branch` | `master`, `release/2.5`, `feature/auth` | Branch git (opcjonalny, przez label kontenera) |

### Skąd pochodzą labele

**Prometheus**: Docker Service Discovery (`docker_sd_configs`) automatycznie wykrywa
kontenery i eksponuje ich Docker labels jako meta-labele. Konfiguracja `relabel_configs`
mapuje label kontenera `com.docker.compose.project` → label Prometheus `env_name`.

**Loki/Promtail**: Pipeline stages wyciągają `env_name` z nazwy kontenera lub Docker labels.

**k6**: Każdy run tagu metryki jawnie przez `--tag env_name=release-2-5`.

**PMM**: Każda instancja MySQL dodawana jest z etykietą `environment` przez PMM API.

---

## Proponowany stack

### 1. Percona PMM — Query Analytics dla MySQL

**Co to jest:** Open-source platforma monitorowania baz danych od Percona
(firmy specjalizującej się w MySQL/PostgreSQL). Darmowa, Docker-ready.

**Dlaczego PMM a nie zwykły slow query log:**
- Zbiera dane z `performance_schema` + slow query log jednocześnie
- Agreguje zapytania statystycznie (avg, p95, p99, calls/min)
- Automatyczny Index Advisor — sugeruje brakujące indeksy
- Wizualizacja `EXPLAIN` — graficznie pokazuje full table scans
- Obsługuje wiele instancji MySQL jednocześnie (każde środowisko Warden = osobna instancja)

**Wielośrodowiskowość w PMM:**

PMM natively obsługuje wiele instancji baz danych. Każde środowisko Warden rejestruje
swoją bazę z etykietą `environment`:

```bash
# Przy tworzeniu środowiska (np. w b/dev-env create)
pmm-admin add mysql \
  --username=root \
  --password=magento \
  --host=db.magento2-release-2-5.test \
  --environment=release-2-5 \
  --cluster=local \
  --service-name=magento-release-2-5
```

W PMM Query Analytics możesz filtrować per środowisko i porównywać zapytania
między `master` a `release-2-5` w tym samym widoku.

**Kluczowe funkcje dla 3W:**
- Query Analytics (QAN) — ranking najkosztowniejszych zapytań
- MySQL InnoDB dashboardy — buffer pool, lock waits, deadlocks
- Node-level metrics — CPU, RAM, I/O per host

**Instalacja (globalna usługa Warden):**
```bash
docker run -d \
  --name pmm-server \
  --network warden \  # sieć Warden — dostęp do wszystkich środowisk
  -p 8080:80 \
  -v pmm-data:/srv \
  percona/pmm-server:3
```

---

### 2. k6 — Load Testing

**Co to jest:** Narzędzie do testów obciążeniowych od Grafana Labs.
Scenariusze w JavaScript, silnik w Go (niski overhead).

**Przewagi nad JMeter/Locust:**
- Bardzo niski overhead narzędzia (nie zakłóca wyników)
- Scenariusze jako kod JS — łatwy version control, CI/CD
- Natywna integracja z Prometheus (metryki live podczas testu)
- Czytelne podsumowania w terminalu

**Tagowanie per środowisko:**
```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';

// Środowisko przekazywane jako zmienna
const ENV_NAME = __ENV.ENV_NAME || 'master';
const BASE_URL = `https://app.${ENV_NAME}.test`;

export const options = {
  stages: [
    { duration: '2m', target: 10 },
    { duration: '5m', target: 50 },
    { duration: '2m', target: 0 },
  ],
  tags: { env_name: ENV_NAME },        // <-- label na wszystkich metrykach k6
  thresholds: {
    http_req_duration: ['p95<3000'],
    http_req_failed:   ['rate<0.01'],
  },
};

export default function () {
  const loginRes = http.post(`${BASE_URL}/api/auth/login`, {
    username: 'handlowiec@3w.pl',
    password: 'test',
  });
  check(loginRes, { 'login OK': (r) => r.status === 200 });

  const headers = { Authorization: `Bearer ${loginRes.json('token')}` };

  http.get(`${BASE_URL}/api/quotes?page=1&limit=20`, { headers });
  sleep(1);

  http.post(`${BASE_URL}/api/quotes`, JSON.stringify({
    customer_id: 12345,
    items: [{ sku: 'PROD-001', qty: 10 }],
  }), { headers, contentType: 'application/json' });

  sleep(2);
}
```

**Uruchomienie z eksportem do Prometheus:**
```bash
# Test master
k6 run \
  --out=experimental-prometheus-rw \
  --tag env_name=master \
  --env ENV_NAME=magento2-master \
  scripts/load-test.js

# Test release
k6 run \
  --out=experimental-prometheus-rw \
  --tag env_name=release-2-5 \
  --env ENV_NAME=magento2-release-2-5 \
  scripts/load-test.js
```

---

### 3. Prometheus + Grafana — Metryki infrastrukturalne

**Prometheus** z Docker Service Discovery automatycznie wykrywa kontenery
wszystkich środowisk Warden i dodaje właściwe labele.

**Konfiguracja Docker SD (fragment `prometheus.yml`):**
```yaml
scrape_configs:
  - job_name: 'warden-containers'
    docker_sd_configs:
      - host: unix:///var/run/docker.sock
        refresh_interval: 15s

    relabel_configs:
      # Wyciągnij env_name z nazwy projektu Docker Compose
      - source_labels: [__meta_docker_container_label_com_docker_compose_project]
        target_label: env_name

      # Wyciągnij komponent (php-fpm, nginx, db...)
      - source_labels: [__meta_docker_container_label_com_docker_compose_service]
        target_label: component

      # Dodaj service (magento, price-server...) z custom Docker label
      - source_labels: [__meta_docker_container_label_observability_service]
        target_label: service

      # Usuń kontenery bez eksportera
      - source_labels: [__meta_docker_container_label_observability_scrape]
        regex: 'true'
        action: keep
```

**Kontenery środowiska Warden otrzymują dodatkowe labele** przez `docker-compose.override.yml`
w każdym projekcie:

```yaml
# magento2/docker-compose.observability.yml
services:
  php-fpm:
    labels:
      observability.scrape: "true"
      observability.service: "magento"

  db:
    labels:
      observability.scrape: "true"
      observability.service: "magento"
```

**Exportery per serwis:**

| Serwis | Exporter | Kluczowe metryki |
|--------|----------|-----------------|
| MariaDB | `mysql_exporter` | connections, queries/s, slow queries, InnoDB |
| Redis | `redis_exporter` | hit rate, memory, evictions |
| PHP-FPM | `php-fpm_exporter` | active workers, queue, max children reached |
| RabbitMQ | `rabbitmq_exporter` | queue depth, consumer lag, message rate |
| Nginx/Traefik | wbudowane metryki | req/s, 5xx rate, upstream latency |
| Node | `node_exporter` | CPU, RAM, disk I/O, network |

**Grafana** jako unified dashboard z zmiennymi filtrującymi:
- `$env_name` — dropdown z wszystkich środowisk (master, release-2-5, ...)
- `$service` — dropdown: magento, price-server, maptica
- `$component` — php-fpm, db, redis...

Pozwala to na porównanie np. `cpu_usage{env_name="master"}` vs
`cpu_usage{env_name="release-2-5"}` na jednym wykresie.

---

### 4. Loki + Promtail — Agregacja logów

Lżejsza alternatywa dla ELK Stack, natywnie zintegrowana z Grafaną.

**Promtail z Docker discovery** — automatycznie zbiera logi ze wszystkich
kontenerów Warden i wzbogaca je o labele środowiska:

```yaml
# promtail-config.yml
scrape_configs:
  - job_name: docker
    docker_sd_configs:
      - host: unix:///var/run/docker.sock
        refresh_interval: 5s

    pipeline_stages:
      - docker: {}   # parsuje format logów Docker (timestamp, stream, log)

    relabel_configs:
      - source_labels: [__meta_docker_container_label_com_docker_compose_project]
        target_label: env_name
      - source_labels: [__meta_docker_container_label_com_docker_compose_service]
        target_label: component
      - source_labels: [__meta_docker_container_label_observability_service]
        target_label: service
```

**Dodatkowe źródła przez file tailing** (logi aplikacji Magento):
```yaml
  - job_name: magento-app-logs
    static_configs:
      - targets: ['localhost']
        labels:
          service: magento
          component: application
    pipeline_stages:
      - match:
          selector: '{component="application"}'
          stages:
            - regex:
                expression: 'ENV_(?P<env_name>[a-z0-9-]+).*'
            - labels:
                env_name:
```

**Źródła logów:**
```
var/log/magento/exception.log    → błędy aplikacji
var/log/magento/system.log       → logi systemowe
MySQL slow query log             → zapytania > 1s
PHP-FPM slow log                 → procesy > 5s
Nginx/Traefik access log         → 4xx/5xx, request timing
Price Server logs                → błędy kalkulacji cen
Maptica logs                     → błędy mapowania dokumentów
```

---

### 5. OpenTelemetry + Grafana Tempo — Distributed Tracing (APM)

Warstwa instrumentacji aplikacji. Pozwala zobaczyć **trace waterfall**
przez wszystkie serwisy:

```
Request POST /api/quotes  [total: 1.2s]  env=release-2-5
  ├─ Magento: Auth middleware       [12ms]
  ├─ Magento: MySQL SELECT customer [340ms]  ← regresja względem master
  ├─ Price Server: calculate()      [180ms]
  ├─ Magento: Redis GET cache       [2ms]
  └─ Magento: MySQL INSERT quote    [780ms]  ← problem
```

Trace'y zawierają label `env_name` i `service` — można porównywać
waterfalle między środowiskami w Grafana Tempo.

**Integracja per serwis:**
- **PHP/Magento**: `open-telemetry/opentelemetry-php` (Composer)
- **Node.js/Nuxt**: `@opentelemetry/sdk-node`
- **Price Server** (jeśli Go/Python): natywne SDK OTel
- **Maptica**: natywne SDK OTel

Wszystkie wysyłają traces do jednego **OTel Collector** (globalny serwis Warden),
który dodaje resource attribute `env_name` na podstawie zmiennej środowiskowej
i forwarduje do Tempo.

> **Alternatywa mniej inwazyjna dla PHP**: **Tideways** (community edition) —
> dedykowany profiler PHP dla platform e-commerce, w tym Magento.

---

### 5b. SigNoz — APM równoległy (opcja porównawcza)

**Kontekst decyzji**: SigNoz jest rozważany jako kandydat na środowisko produkcyjne.
Uruchomienie go lokalnie równolegle z Grafana Tempo pozwala:
- ocenić UX i możliwości SigNoz na realnych trace'ach z naszego systemu
- wypracować konfigurację instrumentacji zanim pojawi się decyzja o produkcji
- uniknąć "odkrywania" narzędzia dopiero na etapie wdrożenia produkcyjnego

**Czym jest SigNoz**: Open-source all-in-one APM (alternatywa dla Datadog/New Relic).
Własne UI z widokami service map, error tracking i porównywaniem wersji. Backend oparty
na ClickHouse.

#### Architektura SigNoz (docker-compose)

SigNoz to nie jest pojedynczy kontener — składa się z ~5 serwisów:

```
signoz-otel-collector   ← własny kolektor OTel (port 4317/4318)
clickhouse              ← główny storage trace'ów i metryk (HEAVY: ~2-4 GB RAM)
query-service           ← backend API dla UI
frontend                ← React UI (:3301)
alertmanager            ← obsługa alertów
```

**Główny koszt lokalny**: ClickHouse wymaga ~2-4 GB RAM. Przy 16+ GB na maszynie
jest to akceptowalne.

#### Klucz: OTel Collector fan-out — jeden punkt instrumentacji, dwa backendy

Instrumentacja aplikacji pozostaje niezmieniona. Globalny OTel Collector (Warden)
rozsyła trace'y do obu backendów jednocześnie przez konfigurację wielu exporterów:

```yaml
# otel-collector-config.yml (fragment)

exporters:
  otlp/tempo:
    endpoint: tempo:4317
    tls:
      insecure: true
  otlp/signoz:
    endpoint: signoz-otel-collector:4317   # port zmieniony z 4317 → unikamy konfliktu
    tls:
      insecure: true

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch, resource]
      exporters: [otlp/tempo, otlp/signoz]   # fan-out do obu równocześnie
```

Aplikacje (Magento, Nuxt, Price Server, Maptica) wysyłają trace'y do jednego punktu
wejścia (globalny OTel Collector na porcie 4318). Routing do backendów jest
transparentny dla kodu aplikacji.

#### Mapowanie labelingu

SigNoz używa standardowych **OTel resource attributes** — mapowanie jest proste:

| Label w Grafana Tempo | Resource attribute w SigNoz |
|-----------------------|-----------------------------|
| `env_name` | `deployment.environment` |
| `service` | `service.name` |
| `component` | `service.instance.id` lub custom attr |

OTel Collector wzbogaca spans o te atrybuty w warstwie `resource` processor:

```yaml
processors:
  resource:
    attributes:
      - key: deployment.environment
        from_attribute: env_name
        action: insert
```

#### Co daje SigNoz ponad Grafana Tempo

| Funkcja | Grafana Tempo | SigNoz |
|---------|--------------|--------|
| Trace waterfall | Tak | Tak |
| Automatyczna service map | Wymaga ręcznej konfiguracji | Wbudowana, auto |
| Porównanie wersji (A/B) | Przez zmienne Grafany | Wbudowane narzędzie |
| Error tracking / grouping | Nie natively | Tak |
| Własne metryki z trace'ów (RED) | Wymaga Prometheus | Automatyczne |
| Korelacja z Prometheus/Loki | Natywna w Grafanie | Ograniczona |

#### Konflikt portów i rozwiązanie

SigNoz domyślnie uruchamia własny OTel Collector na porcie `4317`. Aby uniknąć
konfliktu z globalnym OTel Collector Warden, SigNoz Collector wystawia się na
porcie `4319` (przez `ports` w docker-compose override).

#### Nakład wdrożenia

Dodanie SigNoz do istniejącego stacku to:
1. Dołączenie oficjalnego `docker-compose.yaml` SigNoz do pliku globalnego observability
2. Zmiana portu SigNoz OTel Collector z `4317` na `4319`
3. Dodanie exportera `otlp/signoz` do konfiguracji globalnego OTel Collector (~5 linii)
4. Pierwsze uruchomienie i weryfikacja że trace'y pojawiają się w obu UI

Szacowany czas: **2-4h** (przy działającym stacku OTel+Tempo jako punkcie wyjścia).

---

## Architektura całego stacku

```
Globalne usługi Warden (jedna instancja):
┌──────────────────────────────────────────────────────────────────┐
│                       Grafana :3000                              │
│   Variables: $env_name | $service | $component | $branch         │
│   Sources:   Prometheus | Loki | Tempo | PMM (link)              │
└────────────┬──────────────┬──────────────┬──────────────────────┘
             │              │              │
        Prometheus       Loki           Tempo
        :9090            :3100          :4317
             │              │              │
    docker_sd_configs    Promtail      OTel Collector
    (auto-discovery      docker_sd     :4318
     wszystkich          + file         │
     kontenerów)         tailing        │
             │              │           │
    ─────────┼──────────────┼───────────┼──────── sieć `warden`
             │              │           │
┌────────────┴──────────────┴───────────┴────────┐
│  Środowisko: magento2-master                    │
│  php-fpm | nginx | db | redis | rabbitmq | es   │
│  Labels: env_name=master, service=magento        │
└─────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────┐
│  Środowisko: magento2-release-2-5               │
│  php-fpm | nginx | db | redis | rabbitmq | es   │
│  Labels: env_name=release-2-5, service=magento  │
└─────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────┐
│  Środowisko: price-server-feature-x             │
│  app | db | redis                               │
│  Labels: env_name=ps-feature-x, service=price-server │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────┐
│   Percona PMM :8080                 │
│   Instancje MySQL:                  │
│   - magento-master  (env=master)    │
│   - magento-release (env=release)   │
│   - price-server-db (env=ps-feat-x) │
└─────────────────────────────────────┘

k6 --tag env_name=release-2-5 → Prometheus → Grafana
```

---

## Integracja z narzędziem `b/dev-env`

Observability powinno być zintegrowane z `b/dev-env create` (opisanym w `dynamic-envs.md`),
tak aby każde nowe środowisko automatycznie rejestrowało się w stacku monitoringowym:

```bash
b/dev-env create --branch release/2.5
# Powinno automatycznie:
# 1. Postawić środowisko Warden z właściwymi Docker labels
# 2. Zarejestrować instancję MySQL w PMM
# 3. Dodać target do Prometheus file_sd (jeśli nie używamy docker_sd)
# 4. Opcjonalnie: stworzyć folder w Grafanie dla tego środowiska

b/dev-env destroy --env release-2-5
# Powinno automatycznie:
# 1. Odrejestrować MySQL z PMM
# 2. Usunąć target z Prometheus
```

---

## Workflow porównawczy: master vs release

```bash
# 1. Uruchom globalny stack observability (raz)
docker compose -f ~/.warden/observability.yml up -d

# 2. Utwórz oba środowiska
b/dev-env create --branch master
b/dev-env create --branch release/2.5

# 3. Test na master
k6 run \
  --out=experimental-prometheus-rw \
  --tag env_name=master \
  --env ENV_NAME=magento2-master \
  scripts/load-test.js

# 4. Test na release (równolegle lub sekwencyjnie)
k6 run \
  --out=experimental-prometheus-rw \
  --tag env_name=release-2-5 \
  --env ENV_NAME=magento2-release-2-5 \
  scripts/load-test.js

# 5. Grafana: porównaj oba środowiska
#    - Ustaw $env_name=master i $env_name=release-2-5 na tym samym dashboardzie
#    - PMM Query Analytics: filtruj po environment=master i =release-2-5
#    - Loki: {env_name=~"master|release-2-5"} level=error
```

---

## Plan wdrożenia (priorytety)

### Faza 1 — Fundament (1-2 dni)

- [ ] Docker Compose dla globalnego stacku observability w `~/.warden/`
- [ ] Percona PMM z ręczną rejestracją środowisk
- [ ] Pierwsze scenariusze k6 dla głównych flow Magento
- [ ] Weryfikacja że QAN zbiera dane podczas testu k6

### Faza 2 — Automatyczna discovery (tydzień)

- [ ] Prometheus z `docker_sd_configs` — auto-discovery kontenerów Warden
- [ ] Docker labels w `docker-compose.observability.yml` per serwis (Magento, Price Server, Maptica)
- [ ] Promtail z Docker discovery — logi ze wszystkich środowisk
- [ ] Grafana z dashboardami community + zmienne `$env_name` / `$service`
- [ ] Integracja k6 → Prometheus → Grafana

### Faza 3 — Integracja z `b/dev-env` (tydzień)

- [ ] Auto-rejestracja MySQL w PMM przy `b/dev-env create`
- [ ] Auto-deregistracja przy `b/dev-env destroy`
- [ ] Standaryzacja Docker labels we wszystkich repozytoriach (magento2, price-server, maptica)

### Faza 4 — APM (opcjonalne, inwazyjna integracja)

Dwie rozważane opcje backendu trace'ów — instrumentacja aplikacji jest **identyczna**
w obu przypadkach (OpenTelemetry SDK), więc wybór backendu nie blokuje startu.

#### Opcja A: Grafana Tempo (spójny z resztą stacku)

- [ ] Wybór instrumentacji PHP: OpenTelemetry PHP SDK vs Tideways (mniej inwazyjna alternatywa)
- [ ] Instrumentacja Magento + Nuxt
- [ ] Instrumentacja Price Server + Maptica
- [ ] Grafana Tempo — dashboardy trace waterfall z korelacją Loki/Prometheus

**Kiedy wybierać**: gdy priorytetem jest jedno okno dla wszystkiego (metryki + logi +
traces + k6 w Grafanie) i pełna korelacja między warstwami.

#### Opcja B: SigNoz równolegle (środowisko porównawcze / kandydat produkcyjny)

- [ ] Dodanie SigNoz do `docker-compose.observability.yml` (oficjalny compose SigNoz)
- [ ] Zmiana portu SigNoz OTel Collector: `4317` → `4319` (unikamy konfliktu)
- [ ] Konfiguracja fan-out w globalnym OTel Collector: eksport do Tempo + SigNoz jednocześnie
- [ ] Mapowanie resource attributes (`env_name` → `deployment.environment`)
- [ ] Weryfikacja trace'ów w obu UI po teście k6

**Kiedy wybierać**: gdy SigNoz jest rozważany na produkcji — warto poznać narzędzie
i wypracować konfigurację lokalnie zanim zapadnie decyzja produkcyjna. Obie opcje
mogą działać równolegle bez zmian w kodzie aplikacji.

**Wymagania zasobowe Opcji B**: +2-4 GB RAM na ClickHouse (zalecane 16+ GB na maszynie).

---

## Najważniejsze metryki do śledzenia

| Metryka | Narzędzie | Alert gdy... |
|---------|-----------|-------------|
| MySQL slow queries/min | PMM | > baseline o 20% |
| p95 latencja endpointów | k6 + Grafana | > 3000ms |
| PHP-FPM active workers | Prometheus | > 80% pool size |
| MySQL connections | Prometheus | > 80% max_connections |
| Redis hit rate | Prometheus | < 85% |
| 5xx error rate | Nginx/Traefik exporter | > 0.5% |
| DB query time p95 | PMM QAN | > 2x baseline |
| RabbitMQ queue depth | Prometheus | > 1000 msgs |
| Price Server p95 latency | k6 + Grafana | > 500ms |
| Maptica error rate | Loki | > 0.1% |
