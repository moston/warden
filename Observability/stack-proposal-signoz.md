# Lokalny Stack Observability — Wariant SigNoz

> **Alternatywa do**: [`stack-proposal.md`](stack-proposal.md) (Grafana Tempo + Loki)
>
> **Główna różnica**: SigNoz obsługuje APM (traces) i logi aplikacji w jednym narzędziu.
> Prometheus + Grafana pozostają, ale wyłącznie dla metryk infrastrukturalnych.
> Rezygnujemy z Loki i Promtail.

---

## Kontekst i cel

(Identyczny jak w wariancie bazowym — patrz `stack-proposal.md`)

Wariant SigNoz adresuje te same problemy:

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

---

## Proponowany stack

### Podział odpowiedzialności

```
SigNoz          ← traces (APM) + logi aplikacji + alerty
Prometheus      ← metryki infrastrukturalne (eksportery)
Grafana         ← dashboardy infrastrukturalne (Prometheus data source)
Percona PMM     ← query analytics MySQL
k6              ← testy obciążeniowe
```

**Co odpada względem wariantu bazowego**: Loki, Promtail, Grafana Tempo.

---

### 1. SigNoz — APM + Logi

**Co to jest**: Open-source all-in-one APM (alternatywa dla Datadog/New Relic).
Traces, logi i alerty w jednym UI. Backend na ClickHouse.

**Architektura SigNoz (docker-compose, ~5 serwisów):**

```
signoz-otel-collector   ← kolektor OTel (odbiera traces + logi z aplikacji)
clickhouse              ← storage traces, logów i metryk APM (~2-4 GB RAM)
query-service           ← backend API
frontend                ← UI React (:3301)
alertmanager            ← alerty
```

#### Kolekcja trace'ów

Aplikacje wysyłają traces przez OpenTelemetry SDK do OTel Collector SigNoz:

```
PHP/Magento     → open-telemetry/opentelemetry-php (Composer)
Nuxt/Node.js    → @opentelemetry/sdk-node
Price Server    → natywne OTel SDK (Go/Python)
Maptica         → natywne OTel SDK
```

Trace waterfall po zebraniu danych:

```
Request POST /api/quotes  [total: 1.2s]  env=release-2-5
  ├─ Magento: Auth middleware       [12ms]
  ├─ Magento: MySQL SELECT customer [340ms]  ← regresja
  ├─ Price Server: calculate()      [180ms]
  ├─ Magento: Redis GET cache       [2ms]
  └─ Magento: MySQL INSERT quote    [780ms]  ← problem
```

#### Kolekcja logów — przez OTel Collector

Zamiast Promtaila, logi zbiera OTel Collector przez `filelog` i `docker` receiver.

```yaml
# otel-collector-config.yml (fragment logów)

receivers:
  filelog/magento:
    include:
      - /var/www/html/var/log/magento/exception.log
      - /var/www/html/var/log/magento/system.log
    operators:
      - type: add
        field: resource["service.name"]
        value: magento
      - type: add
        field: resource["deployment.environment"]
        value: '${env:ENV_NAME}'

  docker_logs:
    collect_interval: 5s
    operators:
      - type: add
        field: resource["service.name"]
        from_attribute: com.docker.compose.service

service:
  pipelines:
    logs:
      receivers: [filelog/magento, docker_logs]
      processors: [batch, resource]
      exporters: [otlp/signoz]
```

**Źródła logów:**
```
var/log/magento/exception.log    → błędy aplikacji
var/log/magento/system.log       → logi systemowe
MySQL slow query log             → zapytania > 1s (przez filelog)
PHP-FPM slow log                 → procesy > 5s
logi kontenerów Docker           → nginx, rabbitmq, redis (przez docker_logs)
Price Server logs                → błędy kalkulacji
Maptica logs                     → błędy mapowania
```

#### Natywna korelacja trace ↔ log

Największa przewaga nad Loki: SigNoz automatycznie łączy logi z trace'ami przez
`trace_id`. Klikając span w widoku APM można od razu zobaczyć linie logów
wygenerowane przez to konkretne żądanie.

#### Wielośrodowiskowość w SigNoz

SigNoz używa standardowych OTel resource attributes zamiast custom Docker labels:

| Concept | Wariant Grafana Tempo | Wariant SigNoz |
|---------|-----------------------|----------------|
| Środowisko | label `env_name` | resource attr `deployment.environment` |
| Serwis | label `service` | resource attr `service.name` |
| Komponent | label `component` | resource attr `service.instance.id` |

OTel Collector wzbogaca każdy span i log o te atrybuty:

```yaml
processors:
  resource:
    attributes:
      - key: deployment.environment
        value: '${env:ENV_NAME}'
        action: insert
      - key: service.name
        from_attribute: observability.service   # Docker label
        action: insert
```

---

### 2. Percona PMM — Query Analytics dla MySQL

Bez zmian względem wariantu bazowego. Szczegóły: [`stack-proposal.md`](stack-proposal.md#1-percona-pmm--query-analytics-dla-mysql).

---

### 3. k6 — Load Testing

Bez zmian względem wariantu bazowego. Szczegóły: [`stack-proposal.md`](stack-proposal.md#2-k6--load-testing).

Wyniki k6 trafiają do Prometheusa i są wizualizowane w Grafanie (ta sama integracja).

---

### 4. Prometheus + Grafana — wyłącznie metryki infrastrukturalne

Prometheus i Grafana pozostają, ale ich zakres jest węższy niż w wariancie bazowym
— **bez logów** (nie ma Loki), bez traces (nie ma Tempo).

**Exportery per serwis** (bez zmian):

| Serwis | Exporter | Kluczowe metryki |
|--------|----------|-----------------|
| MariaDB | `mysql_exporter` | connections, queries/s, InnoDB |
| Redis | `redis_exporter` | hit rate, memory, evictions |
| PHP-FPM | `php-fpm_exporter` | active workers, queue |
| RabbitMQ | `rabbitmq_exporter` | queue depth, message rate |
| Nginx/Traefik | wbudowane metryki | req/s, 5xx rate, upstream latency |
| Node | `node_exporter` | CPU, RAM, disk I/O |

Grafana służy wyłącznie do dashboardów infrastrukturalnych i wyników k6.
Logi i traces — SigNoz.

---

## Architektura całego stacku

```
Globalne usługi Warden (jedna instancja):

┌─────────────────────────────────────────────────────────────┐
│                    SigNoz UI :3301                           │
│   Traces | Logs | Alerts | Service Map | Error Tracking      │
└────────────────────────┬────────────────────────────────────┘
                         │
              SigNoz OTel Collector :4317
              ┌──────────┴──────────┐
           Traces                 Logi
        (OTel SDK)           (filelog + docker)
                         │
                      ClickHouse

┌─────────────────────────────────────┐
│         Grafana :3000               │
│   Sources: Prometheus only          │
│   Variables: $env_name | $service   │
└────────────────┬────────────────────┘
                 │
            Prometheus :9090
                 │
         docker_sd_configs
         + exportery serwisów

┌──────────────────────────┐
│   Percona PMM :8080       │
│   Query Analytics MySQL  │
└──────────────────────────┘

k6 --tag env_name=X → Prometheus → Grafana

─────────────────────────────────── sieć `warden`

┌──────────────────────────────────────┐
│  Środowisko: magento2-master          │
│  php-fpm | nginx | db | redis | es   │
│  deployment.environment=master        │
└──────────────────────────────────────┘
┌──────────────────────────────────────┐
│  Środowisko: magento2-release-2-5    │
│  php-fpm | nginx | db | redis | es   │
│  deployment.environment=release-2-5  │
└──────────────────────────────────────┘
```

---

## Porównanie wariantów

| Aspekt | Wariant Grafana Tempo + Loki | Wariant SigNoz |
|--------|------------------------------|----------------|
| Liczba komponentów | 7 (Prometheus, Grafana, Loki, Promtail, Tempo, OTel Collector, PMM) | 5 (Prometheus, Grafana, SigNoz stack, PMM) |
| Jedno UI dla wszystkiego | Grafana (traces + logi + metryki) | Dwa UI: SigNoz + Grafana |
| Korelacja trace ↔ log | Wymaga konfiguracji w Grafanie | Natywna, out of the box |
| Service map | Ręczna konfiguracja | Automatyczna |
| Dojrzałość log UI | Loki + LogQL (bardzo dojrzałe) | SigNoz (funkcjonalne, mniej elastyczne) |
| RAM overhead | Niski (Tempo jest lekki) | +2-4 GB (ClickHouse) |
| Zbieżność z produkcją | Wymaga migracji jeśli produkcja idzie w SigNoz | Identyczna konfiguracja prod/local |
| Próg wejścia | Wyższy (więcej komponentów) | Niższy (mniej konfiguracji log) |

---

## Plan wdrożenia

### Faza 1 — Fundament (1-2 dni)

- [ ] Docker Compose dla globalnego stacku (SigNoz + Prometheus + Grafana + PMM)
- [ ] Percona PMM z ręczną rejestracją środowisk
- [ ] Pierwsze scenariusze k6 dla głównych flow Magento
- [ ] Weryfikacja że PMM QAN zbiera dane podczas testu k6

### Faza 2 — Metryki infrastrukturalne (tydzień)

- [ ] Prometheus z `docker_sd_configs` — auto-discovery kontenerów Warden
- [ ] Docker labels w `docker-compose.observability.yml` per serwis
- [ ] Grafana z dashboardami community dla infrastruktury
- [ ] Integracja k6 → Prometheus → Grafana

### Faza 3 — APM + Logi przez SigNoz (tydzień)

- [ ] Konfiguracja OTel Collector: filelog (Magento logs) + docker receiver
- [ ] Instrumentacja Magento: `open-telemetry/opentelemetry-php`
- [ ] Instrumentacja Nuxt: `@opentelemetry/sdk-node`
- [ ] Instrumentacja Price Server + Maptica
- [ ] Weryfikacja trace waterfall + korelacja z logami w SigNoz UI
- [ ] Resource attributes (`deployment.environment`) per środowisko Warden

### Faza 4 — Integracja z `b/dev-env` (tydzień)

- [ ] Auto-rejestracja MySQL w PMM przy `b/dev-env create`
- [ ] Auto-ustawienie `ENV_NAME` dla OTel Collector przy starcie środowiska
- [ ] Standaryzacja Docker labels we wszystkich repozytoriach

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
| Błędy aplikacji (exception.log) | SigNoz Logs | > threshold / alerty SigNoz |
| Trace p95 per endpoint | SigNoz APM | > 3000ms |
| Price Server p95 latency | k6 + Grafana | > 500ms |
