# SigNoz — Przewodnik konfiguracji

> **Cel dokumentu**: Praktyczny przewodnik "nisko wiszących owoców" — konfiguracje
> które znacząco podnoszą jakość pracy przy minimalnym nakładzie czasu.
>
> **Powiązane dokumenty**: [`stack-proposal-signoz.md`](stack-proposal-signoz.md),
> [`apm-comparison.md`](apm-comparison.md)

---

## Co dostajesz po tym przewodniku

| Funkcja | Nakład |
|---------|--------|
| Lista wszystkich endpointów API z metrykami RED | ~1 dzień |
| Percentyle p50/p90/p99 per endpoint | j.w. |
| Liczba wywołań, error rate, trend w czasie | j.w. |
| Automatyczny widok zapytań SQL, Redis, HTTP per request | j.w. |
| Logi aplikacji (exception.log, system.log) | +2-3h |
| Grupowanie endpointów po wzorcu trasy (nie surowym URL) | +kilka godzin |
| Korelacja log ↔ trace (kliknij span → zobacz logi) | automatyczna po krokach powyżej |

---

## Krok 1: Uruchomienie SigNoz

SigNoz działa jako globalna usługa Warden — tak samo jak Traefik czy Mailpit.
Konfiguracja jest wbudowana w repozytorium Warden i uruchamiana przez `warden svc`.

### Pliki konfiguracyjne

Wszystkie pliki żyją w `docker/` w repozytorium Warden **oraz** muszą być skopiowane
do `~/.warden/` (skąd Docker Compose je montuje jako `./`):

| Plik | Cel |
|------|-----|
| `docker/docker-compose.observability.yml` | Definicja wszystkich serwisów SigNoz |
| `docker/signoz-clickhouse-config.xml` | Konfiguracja klastra ClickHouse (ZooKeeper, logging) |
| `docker/signoz-clickhouse-users.xml` | Override użytkownika `default` (hasło + sieć) |
| `docker/signoz-otel-collector-config.yml` | Pipelines OTLP → ClickHouse |

> **Uwaga**: plik `docker/signoz-frontend-nginx.conf` istnieje w repozytorium jako artefakt
> historyczny, ale **nie jest używany** — nowy obraz `signoz/signoz` łączy frontend i backend
> w jednym kontenerze bez osobnego nginx.

Po każdej zmianie pliku w `docker/` skopiuj go do `~/.warden/`:

```bash
cp docker/signoz-clickhouse-config.xml ~/.warden/
cp docker/signoz-clickhouse-users.xml ~/.warden/
cp docker/signoz-otel-collector-config.yml ~/.warden/
```

### docker-compose.observability.yml

```yaml
services:
  signoz-zookeeper:
    image: signoz/zookeeper:3.9.3
    container_name: signoz-zookeeper
    networks: [warden]
    restart: ${WARDEN_RESTART_POLICY:-always}
    environment:
      ALLOW_ANONYMOUS_LOGIN: "yes"
    volumes:
      - signoz-zookeeper:/bitnami/zookeeper

  signoz-clickhouse:
    image: clickhouse/clickhouse-server:26.2.15.4-alpine
    container_name: signoz-clickhouse
    networks: [warden]
    restart: ${WARDEN_RESTART_POLICY:-always}
    volumes:
      - signoz-clickhouse:/var/lib/clickhouse
      - ./signoz-clickhouse-config.xml:/etc/clickhouse-server/config.d/cluster.xml
      - ./signoz-clickhouse-users.xml:/etc/clickhouse-server/users.d/default-user.xml
    depends_on: [signoz-zookeeper]
    ulimits:
      nofile: { soft: 262144, hard: 262144 }
    healthcheck:
      test: ["CMD", "clickhouse-client", "--query", "SELECT 1"]
      interval: 5s
      timeout: 5s
      retries: 10
      start_period: 30s

  signoz-schema-migrator:
    image: signoz/signoz-otel-collector:v0.144.3   # ten sam obraz co kolektor
    container_name: signoz-schema-migrator
    networks: [warden]
    restart: "no"
    entrypoint: ["/bin/sh", "-c"]
    command:
      - |
        /signoz-otel-collector migrate bootstrap \
          --clickhouse-dsn tcp://signoz-clickhouse:9000 \
          --clickhouse-replication=false &&
        /signoz-otel-collector migrate sync up \
          --clickhouse-dsn tcp://signoz-clickhouse:9000 \
          --clickhouse-replication=false \
          --timeout 5m
    depends_on:
      signoz-clickhouse:
        condition: service_healthy

  signoz:
    image: signoz/signoz:${SIGNOZ_VERSION:-latest}   # unified frontend + backend
    container_name: signoz
    networks: [warden]
    restart: ${WARDEN_RESTART_POLICY:-always}
    ports:
      - "3301:8080"
    volumes:
      - signoz-db:/var/lib/signoz
    environment:
      - SIGNOZ_ALERTMANAGER_PROVIDER=signoz
      - SIGNOZ_TELEMETRYSTORE_CLICKHOUSE_DSN=tcp://signoz-clickhouse:9000
      - SIGNOZ_SQLSTORE_SQLITE_PATH=/var/lib/signoz/signoz.db
      - SIGNOZ_TOKENIZER_JWT_SECRET=${SIGNOZ_JWT_SECRET:-changeme-use-random-secret}
    depends_on:
      signoz-schema-migrator:
        condition: service_completed_successfully

  signoz-otel-collector:
    image: signoz/signoz-otel-collector:v0.144.3
    container_name: signoz-otel-collector
    networks: [warden]
    restart: ${WARDEN_RESTART_POLICY:-always}
    command:
      - --config=/etc/otel/config.yaml
      - --copy-path=/var/tmp/collector-config.yaml
    ports:
      - "4319:4317"   # gRPC — port 4319 aby uniknąć konfliktu z globalnym OTel Collector
      - "4320:4318"   # HTTP
    volumes:
      - ./signoz-otel-collector-config.yml:/etc/otel/config.yaml
    depends_on:
      signoz-schema-migrator:
        condition: service_completed_successfully

volumes:
  signoz-zookeeper:
  signoz-clickhouse:
  signoz-db:

networks:
  warden:
    external: true
```

**Ważne zmiany architektury względem poprzednich wersji SigNoz:**
- Osobne serwisy `signoz-query-service` i `signoz-frontend` zostały zastąpione jednym serwisem `signoz` (unified image).
- `signoz-schema-migrator` używa tego samego obrazu co kolektor (`signoz-otel-collector`) — nie istnieje już osobny obraz `signoz-schema-migrator`.
- Kolejność startowania kontrolowana jest przez `healthcheck` na ClickHouse i `condition: service_completed_successfully` / `service_healthy`.

### signoz-clickhouse-config.xml

Konfiguruje połączenie ZooKeeper, klaster replikacji (pojedynczy węzeł) oraz wycisza
domyślne logi systemowe ClickHouse (query_log, trace_log itp.), które niepotrzebnie zajmują
miejsce w środowisku lokalnym.

```xml
<clickhouse>
    <logger>
        <level>warning</level>
        <console>true</console>
    </logger>

    <query_thread_log remove="remove"/>
    <query_log remove="remove"/>
    <text_log remove="remove"/>
    <trace_log remove="remove"/>
    <metric_log remove="remove"/>
    <asynchronous_metric_log remove="remove"/>

    <zookeeper>
        <node>
            <host>signoz-zookeeper</host>
            <port>2181</port>
        </node>
    </zookeeper>

    <remote_servers>
        <cluster>
            <shard>
                <replica>
                    <host>signoz-clickhouse</host>
                    <port>9000</port>
                </replica>
            </shard>
        </cluster>
    </remote_servers>

    <macros>
        <shard>01</shard>
        <replica>01</replica>
    </macros>
</clickhouse>
```

### signoz-clickhouse-users.xml

ClickHouse 24.x+ domyślnie generuje losowe hasło dla użytkownika `default`
i ogranicza dostęp do localhost. Ten plik nadpisuje obydwa ograniczenia:

```xml
<clickhouse>
    <users>
        <default>
            <password></password>
            <networks>
                <ip>::/0</ip>
            </networks>
            <profile>default</profile>
            <quota>default</quota>
            <access_management>1</access_management>
        </default>
    </users>
</clickhouse>
```

Montowany jako `/etc/clickhouse-server/users.d/default-user.xml` — nadpisuje plik
z obrazu Dockera, który ogranicza sieć do `::1` i `127.0.0.1`.

### signoz-otel-collector-config.yml

```yaml
connectors:
  signozmeter:
    metrics_flush_interval: 1h
    dimensions:
      - name: service.name
      - name: deployment.environment
      - name: host.name

receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318
  prometheus:
    config:
      global:
        scrape_interval: 60s
      scrape_configs:
        - job_name: otel-collector
          static_configs:
            - targets:
                - localhost:8888
              labels:
                job_name: otel-collector

processors:
  batch:
    send_batch_size: 10000
    send_batch_max_size: 11000
    timeout: 10s
  batch/meter:
    send_batch_max_size: 25000
    send_batch_size: 20000
    timeout: 1s
  resourcedetection:
    detectors: [env, system]
    timeout: 2s
  signozspanmetrics/delta:
    metrics_exporter: signozclickhousemetrics
    metrics_flush_interval: 60s
    latency_histogram_buckets: [100us, 1ms, 2ms, 6ms, 10ms, 50ms, 100ms, 250ms, 500ms, 1000ms, 1400ms, 2000ms, 5s, 10s, 20s, 40s, 60s]
    dimensions_cache_size: 100000
    aggregation_temporality: AGGREGATION_TEMPORALITY_DELTA
    enable_exp_histogram: true
    dimensions:
      - name: service.namespace
        default: default
      - name: deployment.environment
        default: default
      - name: signoz.collector.id
      - name: service.version
      - name: host.name

extensions:
  health_check:
    endpoint: 0.0.0.0:13133
  pprof:
    endpoint: 0.0.0.0:1777

exporters:
  clickhousetraces:
    datasource: tcp://signoz-clickhouse:9000/signoz_traces
    low_cardinal_exception_grouping: false
    use_new_schema: true
  signozclickhousemetrics:
    dsn: tcp://signoz-clickhouse:9000/signoz_metrics
  clickhouselogsexporter:
    dsn: tcp://signoz-clickhouse:9000/signoz_logs
    timeout: 10s
    use_new_schema: true
  signozclickhousemeter:
    dsn: tcp://signoz-clickhouse:9000/signoz_meter
    timeout: 45s
    sending_queue:
      enabled: false
  metadataexporter:
    cache:
      provider: in_memory
    dsn: tcp://signoz-clickhouse:9000/signoz_metadata
    enabled: true
    timeout: 45s

service:
  telemetry:
    logs:
      encoding: json
  extensions: [health_check, pprof]
  pipelines:
    traces:
      receivers: [otlp]
      processors: [signozspanmetrics/delta, batch]
      exporters: [clickhousetraces, metadataexporter, signozmeter]
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [signozclickhousemetrics, metadataexporter, signozmeter]
    metrics/prometheus:
      receivers: [prometheus]
      processors: [batch]
      exporters: [signozclickhousemetrics, metadataexporter, signozmeter]
    logs:
      receivers: [otlp]
      processors: [batch]
      exporters: [clickhouselogsexporter, metadataexporter, signozmeter]
    metrics/meter:
      receivers: [signozmeter]
      processors: [batch/meter]
      exporters: [signozclickhousemeter]
```

### Uruchomienie

```bash
# Kopiuj pliki konfiguracyjne
cp docker/signoz-clickhouse-config.xml ~/.warden/
cp docker/signoz-clickhouse-users.xml ~/.warden/
cp docker/signoz-otel-collector-config.yml ~/.warden/

# Uruchom wszystkie serwisy
warden svc up

# UI dostępne pod: http://localhost:3301
```

`signoz-schema-migrator` uruchomi się raz (kolejno: `migrate bootstrap`, potem `migrate sync up`),
stworzy bazy i tabele w ClickHouse, po czym zakończy działanie (exit 0) — to normalne zachowanie.
Pozostałe serwisy (`signoz`, `signoz-otel-collector`) czekają na `service_completed_successfully`
tego migratora, więc wystartują dopiero po jego zakończeniu.

**Wymagania zasobowe**: ~3-4 GB RAM (głównie ClickHouse).

---

## Znane problemy i ich rozwiązania

### ClickHouse: Authentication failed (kod 516)

**Objaw**: `signoz-otel-collector` restartuje się w pętli z błędem
`Authentication failed: password is incorrect`.

**Przyczyna**: ClickHouse 24.x+ generuje losowe hasło dla użytkownika `default`
przy pierwszym starcie i ogranicza sieć do localhost.

**Rozwiązanie**: plik `signoz-clickhouse-users.xml` podmontowany jako
`/etc/clickhouse-server/users.d/default-user.xml` — wymaga restartu kontenera
po pierwszym dodaniu.

### ClickHouse: Database does not exist (kod 81)

**Objaw**: `Database signoz_traces does not exist` po rozwiązaniu problemu z hasłem.

**Przyczyna**: `signoz-schema-migrator` nie ukończył migracji przed startem kolektora.

**Rozwiązanie**: serwis `signoz-schema-migrator` używa obrazu `signoz/signoz-otel-collector:v0.144.3`
i wykonuje kolejno dwa kroki:
```
/signoz-otel-collector migrate bootstrap --clickhouse-dsn ... --clickhouse-replication=false
/signoz-otel-collector migrate sync up   --clickhouse-dsn ... --clickhouse-replication=false --timeout 5m
```
Oba serwisy `signoz` i `signoz-otel-collector` mają `condition: service_completed_successfully`
— jeśli migrator się nie kończy poprawnie (exit 0), pozostałe serwisy nie wystartują.

### signoz-schema-migrator nie kończy się (wisi)

**Objaw**: kontener `signoz-schema-migrator` działa przez wiele minut bez zakończenia.

**Przyczyna**: ClickHouse nie przeszedł healthcheck — migrator stara się połączyć z niedostępną
bazą.

**Rozwiązanie**: sprawdź stan ClickHouse: `docker logs signoz-clickhouse`. Najczęstsza przyczyna
to problem z hasłem (patrz wyżej) lub brak pliku `signoz-clickhouse-users.xml` w `~/.warden/`.

---

## Krok 2: Instrumentacja Magento (PHP)

### 2a. Instalacja SDK przez Composer

```bash
# W katalogu codebase/magento2/
composer require \
  open-telemetry/sdk \
  open-telemetry/exporter-otlp \
  open-telemetry/opentelemetry-auto-pdo \
  open-telemetry/opentelemetry-auto-guzzle \
  mismatch/opentelemetry-auto-redis \
  open-telemetry/opentelemetry-auto-ext-amqp
```

Każda z paczek `opentelemetry-auto-*` automatycznie przechwytuje wywołania
odpowiedniej biblioteki bez zmian w kodzie Magento:
- `auto-pdo` → każde zapytanie SQL z treścią i czasem wykonania
- `auto-guzzle` → wywołania HTTP (Price Server, zewnętrzne API)
- `auto-redis` → operacje cache (GET/SET/DEL z kluczem i czasem)
- `auto-amqplib` → publish/consume wiadomości RabbitMQ

### 2b. Plik bootstrap OTel

Plik `app/code/Strix/Observability/otel-bootstrap.php` — ładowany przez PHP-FPM
jako `auto_prepend_file`. Tworzy span per request (server span), rejestruje
`shutdown_function` kończący span z kodem HTTP i metrykami pamięci, i wystawia
tracer globalnie przez `Globals::registerInitializer`.

```php
<?php

require_once dirname(__DIR__, 4) . '/vendor/autoload.php';

use OpenTelemetry\API\Globals;
use OpenTelemetry\API\Instrumentation\Configurator;
use OpenTelemetry\API\Trace\SpanKind;
use OpenTelemetry\API\Trace\StatusCode;
use OpenTelemetry\Contrib\Otlp\SpanExporter;
use OpenTelemetry\SDK\Common\Attribute\Attributes;
use OpenTelemetry\SDK\Common\Time\ClockFactory;
use OpenTelemetry\SDK\Resource\ResourceInfo;
use OpenTelemetry\SDK\Resource\ResourceInfoFactory;
use OpenTelemetry\SDK\Trace\SpanProcessor\BatchSpanProcessor;
use OpenTelemetry\SDK\Trace\TracerProvider;
use OpenTelemetry\SemConv\ResourceAttributes;

class PHPFPMTracer
{
    private static $instance = null;
    private $tracer;
    private $tracerProvider;
    private $requestSpan;
    private $requestScope;
    private $processId;
    private $startTime;

    private function __construct()
    {
        $this->processId = getmypid();
        $this->startTime = microtime(true);
        $this->initializeTracer();
        $this->startRequestTrace();
    }

    public static function getInstance()
    {
        if (self::$instance === null) {
            self::$instance = new self();
        }

        return self::$instance;
    }

    private static function resolveMagentoVersion(): string
    {
        if ($env = getenv('MAGENTO_VERSION')) {
            return $env;
        }
        $lockFile = dirname(__DIR__, 4) . '/composer.lock';
        if (is_readable($lockFile)) {
            $lock = json_decode(file_get_contents($lockFile), true);
            foreach ($lock['packages'] ?? [] as $pkg) {
                if ($pkg['name'] === 'magento/product-community-edition') {
                    return $pkg['version'];
                }
            }
        }

        return 'unknown';
    }

    private function initializeTracer()
    {
        $poolName = getenv('PHP_FPM_POOL') ?: 'default';

        $resource = ResourceInfoFactory::defaultResource()->merge(
            ResourceInfo::create(Attributes::create([
                ResourceAttributes::SERVICE_NAME => 'magento',
                ResourceAttributes::SERVICE_VERSION => $this->resolveMagentoVersion(),
                ResourceAttributes::DEPLOYMENT_ENVIRONMENT_NAME => getenv('ENV_NAME') ?: 'local',
                ResourceAttributes::PROCESS_PID => $this->processId,
                ResourceAttributes::HOST_NAME => gethostname(),
                'php.fpm.pool' => $poolName,
                'php.sapi' => php_sapi_name(),
            ]))
        );

        $httpTransportFactory = new \OpenTelemetry\Contrib\Otlp\OtlpHttpTransportFactory();

        $baseEndpoint = rtrim(getenv('OTEL_EXPORTER_OTLP_ENDPOINT') ?: 'http://localhost:4318', '/');
        if (!str_ends_with($baseEndpoint, '/v1/traces')) {
            $baseEndpoint .= '/v1/traces';
        }

        $exporter = new SpanExporter(
            $httpTransportFactory->create(
                endpoint: $baseEndpoint,
                contentType: 'application/json',
                timeout: 2.,
                retryDelay: 0,
                maxRetries: 0,
            )
        );

        $this->tracerProvider = TracerProvider::builder()
                                              ->addSpanProcessor(new BatchSpanProcessor($exporter,
                                                  ClockFactory::getDefault()))
                                              ->setResource($resource)
                                              ->build();

        Globals::registerInitializer(function (Configurator $configurator) {
            return $configurator->withTracerProvider($this->tracerProvider);
        });
        $this->tracer = $this->tracerProvider->getTracer('php-fpm-instrumentation');
    }

    private function startRequestTrace()
    {
        $requestMethod = $_SERVER['REQUEST_METHOD'] ?? 'CLI';
        $requestUri = $_SERVER['REQUEST_URI'] ?? 'unknown';

        $this->requestSpan = $this->tracer
            ->spanBuilder("$requestMethod $requestUri")
            ->setSpanKind(SpanKind::KIND_SERVER)
            ->setAttribute('http.method', $requestMethod)
            ->setAttribute('http.url', $requestUri)
            ->setAttribute('http.scheme', $_SERVER['REQUEST_SCHEME'] ?? 'http')
            ->setAttribute('http.host', $_SERVER['HTTP_HOST'] ?? 'unknown')
            ->setAttribute('http.target', $requestUri)
            ->setAttribute('net.peer.ip', $_SERVER['REMOTE_ADDR'] ?? 'unknown')
            ->setAttribute('php.fpm.process.id', $this->processId)
            ->setAttribute('php.fpm.process.start_time', $this->startTime)
            ->startSpan();

        $this->requestScope = $this->requestSpan->activate();

        register_shutdown_function([$this, 'endRequestTrace']);
    }

    public function endRequestTrace()
    {
        if ($this->requestSpan) {
            $endTime = microtime(true);
            $duration = $endTime - $this->startTime;

            $this->requestSpan
                ->setAttribute('http.status_code', http_response_code())
                ->setAttribute('php.memory.peak', memory_get_peak_usage(true))
                ->setAttribute('php.memory.current', memory_get_usage(true))
                ->setAttribute('php.duration', $duration)
                ->setAttribute('php.opcache.enabled', function_exists('opcache_get_status'))
                ->setStatus(StatusCode::STATUS_OK)
                ->end();

            $this->requestScope?->detach();
            $this->tracerProvider->shutdown();
        }
    }

    public function traceFunction(string $functionName, callable $function, array $attributes = [])
    {
        $span = $this->tracer
            ->spanBuilder($functionName)
            ->setSpanKind(SpanKind::KIND_INTERNAL);

        foreach ($attributes as $key => $value) {
            $span->setAttribute($key, $value);
        }

        $span = $span->startSpan();
        $scope = $span->activate();

        try {
            $result = $function();
            $span->setStatus(StatusCode::STATUS_OK);

            return $result;
        } catch (\Throwable $e) {
            $span
                ->recordException($e)
                ->setStatus(StatusCode::STATUS_ERROR, $e->getMessage());
            throw $e;
        } finally {
            $span->end();
            $scope->detach();
        }
    }
}

PHPFPMTracer::getInstance();
```

Kilka szczegółów implementacyjnych wartych uwagi:
- Endpoint budowany jest dynamicznie — jeśli `OTEL_EXPORTER_OTLP_ENDPOINT` nie kończy się na `/v1/traces`, suffix jest dodawany automatycznie. Ustaw zmienną bez ścieżki, np. `http://signoz-otel-collector:4320`.
- Wersja Magento rozwiązywana jest z `composer.lock` (fallback), jeśli nie ustawiono `MAGENTO_VERSION`.
- `timeout: 2s`, `maxRetries: 0` — eksporter nie blokuje requestu przy niedostępnym kolektorze.
- Metoda `traceFunction()` pozwala owinąć dowolny callable custom spanem bez zmian w kodzie wywoływanym.

### 2c. Konfiguracja PHP-FPM

W pliku konfiguracyjnym PHP-FPM środowiska Warden (`.warden/warden-env.yml` lub
`docker-compose.override.yml`) dodaj zmienną środowiskową:

```yaml
services:
  php-fpm:
    environment:
      ENV_NAME: "${WARDEN_ENV_NAME}"
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://signoz-otel-collector:4318"   # port wewnętrzny sieci Docker; bootstrap doda /v1/traces
    volumes:
      - ./app/code/Strix/Observability/otel-bootstrap.php:/var/www/html/otel-bootstrap.php
```

W `php.ini` (lub `php-fpm.conf`):

```ini
auto_prepend_file = /var/www/html/otel-bootstrap.php
```

**Po tym kroku**: restart PHP-FPM i pierwsze traces pojawiają się w SigNoz UI
pod `http://localhost:3301` → zakładka **Services → magento**.

---

## Krok 3: Normalizacja URL endpointów API

Bez tego każdy request do `/rest/V1/quotes/1234` i `/rest/V1/quotes/5678`
tworzy osobny "endpoint" w SigNoz. Normalizacja grupuje je jako `/rest/V1/quotes/{id}`.

Utwórz plugin Magento (`app/code/Strix/Observability/Plugin/RestRouterPlugin.php`):

```php
<?php

namespace Strix\Observability\Plugin;

use Magento\Webapi\Controller\Rest\Router;
use Magento\Framework\Webapi\Rest\Request;
use OpenTelemetry\API\Trace\Span;

class RestRouterPlugin
{
    public function afterMatch(Router $subject, $result, Request $request): mixed
    {
        if ($result === null) {
            return $result;
        }

        $routeName = strtoupper($request->getMethod()) . ' /rest/' . $result->getRoutePath();
        Span::getCurrent()->updateName($routeName);

        return $result;
    }
}
```

Kilka rzeczy wartych odnotowania:
- `getRoutePath()` zwraca wzorzec trasy ze zmiennymi w postaci `:paramName` (np. `V1/quotes/:quoteId/items`) — dostępna na `Magento\Webapi\Controller\Rest\Router\Route`. **Nie istnieje metoda `getRoute()`.**
- `Span::getCurrent()` pobiera aktywny request-span z bootstrapa — nie trzeba tworzyć nowego spana ani zarządzać scope'em.
- Jeśli OTel nie jest skonfigurowany, `getCurrent()` zwraca no-op span, który bezpiecznie ignoruje wszystkie wywołania.

Zarejestruj plugin w `app/code/Strix/Observability/etc/di.xml`:

```xml
<config>
    <type name="Magento\Webapi\Controller\Rest\Router">
        <plugin name="strix_observability_rest_router"
                type="Strix\Observability\Plugin\RestRouterPlugin" />
    </type>
</config>
```

```bash
bin/magento setup:di:compile
bin/magento cache:clean
```

---

## Krok 3b: Normalizacja nazw komend CLI

Bootstrap (`otel-bootstrap.php`) ładowany jest przez `auto_prepend_file` — na obrazach
opartych na RHEL/AlmaLinux (Warden używa `dnf`) plik `/etc/php.d/zz-config.ini` jest
globalny i obejmuje **oba** SAPI: FPM i CLI. Bootstrap automatycznie wykrywa tryb CLI
i tworzy span `cli` z `SpanKind::KIND_INTERNAL` zamiast HTTP-owego `KIND_SERVER`.

Plugin Magento nadpisuje tymczasową nazwę `cli` właściwą nazwą komendy i ustawia
status spana na podstawie exit code:

```php
<?php

declare(strict_types=1);

namespace Strix\Observability\Plugin;

use Magento\Framework\Console\Cli;
use OpenTelemetry\API\Trace\Span;
use OpenTelemetry\API\Trace\StatusCode;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Output\OutputInterface;

class CliCommandPlugin
{
    public function aroundRun(
        Cli $subject,
        callable $proceed,
        InputInterface $input = null,
        OutputInterface $output = null
    ): int {
        $commandName = $input?->getFirstArgument() ?? $_SERVER['argv'][1] ?? 'list';
        Span::getCurrent()->updateName('cli ' . $commandName);

        $exitCode = $proceed($input, $output);

        $span = Span::getCurrent();
        if ($exitCode !== 0) {
            $span->setStatus(StatusCode::STATUS_ERROR, 'Exit code: ' . $exitCode);
        } else {
            $span->setStatus(StatusCode::STATUS_OK);
        }

        return $exitCode;
    }
}
```

Zarejestruj w `etc/di.xml` (obok pluginu REST):

```xml
<type name="Magento\Framework\Console\Cli">
    <plugin name="strix_observability_cli_command"
        type="Strix\Observability\Plugin\CliCommandPlugin" />
</type>
```

Jak to działa:
- Bootstrap tworzy span `cli` z `cli.argv` = surowe argumenty (np. `cache:flush --all`)
- Plugin uruchamia się po zainicjowaniu kontenera DI — aktualizuje nazwę spana na `cli cache:flush`
- Status spana pochodzi z exit code komendy, nie z `http_response_code()`
- Shutdown function kończy span i flushuje do kolektora

Po tej konfiguracji SigNoz pokazuje komendy jako osobne operacje, np.:
```
cli cache:flush         [120ms]  OK
cli setup:di:compile    [ 45s ]  OK
cli indexer:reindex     [ 3m  ]  ERROR (exit 1)
```

---

## Krok 4: Instrumentacja Nuxt / Node.js

Znacznie prostsza niż PHP — OTel w Node.js ma dojrzałe auto-instrumentacje
dla Express/HTTP i wszystkich popularnych bibliotek.

```bash
# W codebase/merchant-panel-app/
npm install \
  @opentelemetry/sdk-node \
  @opentelemetry/auto-instrumentations-node \
  @opentelemetry/exporter-trace-otlp-http
```

Utwórz `instrumentation.ts` w katalogu głównym projektu:

```typescript
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { SEMRESATTRS_SERVICE_NAME, SEMRESATTRS_DEPLOYMENT_ENVIRONMENT } from '@opentelemetry/semantic-conventions';

const sdk = new NodeSDK({
  resource: new Resource({
    [SEMRESATTRS_SERVICE_NAME]: 'nuxt',
    [SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]: process.env.ENV_NAME ?? 'local',
  }),
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://signoz-otel-collector:4320/v1/traces',
  }),
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();
```

W `nuxt.config.ts`:

```typescript
export default defineNuxtConfig({
  nitro: {
    externals: {
      inline: ['@opentelemetry/sdk-node'],
    },
  },
  hooks: {
    'nitro:init': () => {
      import('./instrumentation');
    },
  },
});
```

---

## Krok 5: Kolekcja logów Magento

Zamiast Promtaila, logi zbiera OTel Collector przez `filelog` receiver.

Dodaj do konfiguracji globalnego OTel Collectora (`otel-collector-config.yml`):

```yaml
receivers:
  filelog/magento:
    include:
      - /var/www/html/var/log/magento/exception.log
      - /var/www/html/var/log/magento/system.log
    start_at: end
    operators:
      - type: add
        field: resource["service.name"]
        value: magento
      - type: add
        field: resource["deployment.environment"]
        value: '${env:ENV_NAME}'
      # Oznacz logi z exception.log jako błędy
      - type: router
        routes:
          - output: mark_error
            expr: 'attributes["log.file.name"] == "exception.log"'
      - id: mark_error
        type: add
        field: attributes["level"]
        value: error

  docker_logs/magento:
    collect_interval: 5s
    operators:
      - type: filter
        expr: 'resource["com.docker.compose.service"] matches "php-fpm|nginx"'
      - type: add
        field: resource["service.name"]
        value: magento

service:
  pipelines:
    logs:
      receivers: [filelog/magento, docker_logs/magento]
      processors: [batch, resource]
      exporters: [otlp/signoz]
```

Po tej konfiguracji zakładka **Logs** w SigNoz pokazuje logi Magento z możliwością
filtrowania per środowisko, serwis i poziom severity. Klikając span w widoku traces
widzisz automatycznie powiązane linie logów z tego samego `trace_id`.

---

## Co masz po wszystkich krokach

```
SigNoz UI → Services → magento

Ostatnie 1h:
┌──────────────────────────────────────────────────────────────────┐
│ Endpoint                         │ Req/min │  p50  │  p99  │ Err │
├──────────────────────────────────────────────────────────────────┤
│ POST /rest/V1/quotes             │  34     │ 210ms │ 1.4s  │ 0%  │
│ GET  /rest/V1/quotes/{quoteId}   │ 120     │  45ms │ 340ms │ 0%  │
│ POST /rest/V1/orders             │  12     │ 890ms │ 3.2s  │ 2%  │  ← problem
│ GET  /rest/V1/products/search    │  89     │ 120ms │ 980ms │ 0%  │
└──────────────────────────────────────────────────────────────────┘

Kliknij POST /rest/V1/orders → lista traces → kliknij wolny trace:

Request POST /rest/V1/orders              [3.1s]
  ├─ PDO: SELECT customer WHERE id=?      [  40ms]
  ├─ HTTP: GET price-server/calculate     [ 180ms]
  ├─ PDO: SELECT stock WHERE sku IN (?)   [ 820ms]  ← slow query
  ├─ Redis: GET session_cart_xxxxx        [   2ms]
  └─ PDO: INSERT INTO sales_order (...)   [2058ms]  ← problem
```

---

## Kolejne kroki (opcjonalne, gdy pojawi się potrzeba)

| Krok | Wartość | Nakład |
|------|---------|--------|
| Custom spans dla logiki biznesowej Magento | Widok "które moduły są wolne" | Dni, iteracyjnie |
| Sampling na produkcji (10% requestów) | Redukcja kosztów storage | 1h — zmiana `OTEL_SAMPLING_RATIO` |
| Alerty w SigNoz (np. p99 > 3s) | Powiadomienia o regresji | 2-3h |
| Instrumentacja Price Server | Traces cross-service z Magento | 0.5 dnia |
| Instrumentacja Maptica | j.w. | 0.5 dnia |
