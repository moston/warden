# Porównanie rozwiązań APM: SigNoz vs Apache SkyWalking vs Uptrace

> **Kontekst**: Analiza dla projektu 3W Sales Panel. Wymagania: self-hosted, w pełni darmowe,
> obsługa rozbudowanej architektury multi-VM (PHP/Magento 2 + Nuxt/Node.js + serwisy pomocnicze).
> Punkt odniesienia jakościowego: New Relic.

---

## Profil każdego rozwiązania

### SigNoz (2021, Apache 2.0)

Nowoczesny open-source APM budowany z myślą o OpenTelemetry jako pierwszorzędnym protokole.
Backend na ClickHouse. Aktywnie rozwijany przez dedykowany zespół, rosnąca społeczność.
Trzy filary observability (traces, metryki, logi) w jednym narzędziu.

### Apache SkyWalking (2015, Apache 2.0)

Najstarszy i najbardziej dojrzały z trójki. Wywodzi się z ekosystemu Java i dużych firm
azjatyckich (Alibaba, Huawei jako główni kontrybutorzy). Obsługuje traces, metryki, logi
oraz profiling. Projekt Apache Software Foundation.

### Uptrace (2021, BSL 1.1)

Lekki APM na ClickHouse, OTel-native. Najmniejsza społeczność z trójki.

> **Uwaga krytyczna — licencja**: Uptrace zmienił licencję na Business Source License (BSL 1.1),
> która zabrania oferowania Uptrace jako usługi konkurencyjnej. Dla wewnętrznego self-hostingu
> technicznie jest darmowy, ale BSL to nie jest open-source w tradycyjnym sensie. Wymaga
> weryfikacji prawnej przed wdrożeniem produkcyjnym.

---

## Tabela porównawcza

| Kryterium | SigNoz | SkyWalking | Uptrace |
|-----------|--------|------------|---------|
| **Licencja** | Apache 2.0 (w pełni wolna) | Apache 2.0 | BSL 1.1 (ograniczenia) |
| **Dojrzałość** | Średnia, szybko rośnie | Wysoka (10 lat) | Niska |
| **Społeczność** | Aktywna, rosnąca | Duża (Asia-centric) | Mała |
| **OTel native** | Tak, pierwszorzędny | Częściowy (własne agenty + OTel) | Tak, pierwszorzędny |
| **Storage** | ClickHouse | Elasticsearch lub BanyanDB | ClickHouse |
| **PHP support** | Przez OTel SDK | Własny agent PHP (mało aktywny) | Przez OTel SDK |
| **Node.js support** | Przez OTel SDK | Przez OTel SDK | Przez OTel SDK |
| **UI** | Nowoczesny, APM-first | Funkcjonalny, starszy | Nowoczesny, minimalistyczny |
| **Service Map** | Automatyczna | Automatyczna | Automatyczna |
| **Logi** | Tak | Tak | Tak |
| **Lokalnie: RAM** | ~3-4 GB (ClickHouse) | ~5-8 GB (Elasticsearch) | ~3-4 GB (ClickHouse) |
| **Trudność konfiguracji** | Średnia | Wysoka | Niska–Średnia |
| **Koszt utrzymania prod.** | Średni | Wysoki | Średni |

---

## Kluczowa kwestia dla stosu PHP/Magento

To punkt gdzie wszystkie trzy rozwiązania mają wspólną słabość względem New Relic.

**New Relic PHP agent** działa przez rozszerzenie C — instalujesz pakiet i Magento jest
automatycznie instrumentowany bez zmian w kodzie. Wszystkie zapytania MySQL, wywołania
Redis, HTTP requests — zbierane automatycznie.

**OTel PHP SDK** (SigNoz i Uptrace) wymaga:
- Ręcznego dodania SDK przez Composer
- Konfiguracji bootstrapa w Magento
- Osobnych pakietów `open-telemetry/opentelemetry-auto-*` dla poszczególnych integracji
  (PDO, Redis, Guzzle, etc.) — działają, ale wymagają konfiguracji i testowania

**SkyWalking PHP agent** istnieje jako rozszerzenie C (podobnie do New Relic), co
teoretycznie daje bliższe "zero-code" podejście — jednak jest mało aktywnie rozwijany,
dokumentacja dla Magento praktycznie nie istnieje.

---

## Porównanie z New Relic

### Co osiągasz na poziomie New Relic

- Distributed tracing przez wszystkie serwisy
- Logi z korelacją do trace'ów
- Service map i zależności między komponentami
- Metryki RED (Rate, Errors, Duration) per endpoint
- Alerty na przekroczenie progów

### Czego nie osiągasz lub co będzie gorsze

| Funkcja | New Relic | SigNoz / SkyWalking / Uptrace |
|---------|-----------|-------------------------------|
| **Profiling kodu PHP** | Tak — widok do poziomu linii kodu | Niedostępny out of the box |
| **Real User Monitoring (RUM)** | Tak | Brak lub bardzo ograniczony |
| **Anomaly detection (ML)** | Automatyczne | Brak |
| **Magento-specific dashboardy** | Gotowe | Brak, trzeba budować samemu |
| **Czas do pierwszych danych** | Minuty (auto-agent) | Dni (konfiguracja OTel) |
| **Onboarding dla nowych deweloperów** | Dokumentacja klasy enterprise | Community docs, luki |

---

## Rekomendacja

> **Decyzja architektoniczna (aktualna)**: produkcja idzie w **Grafanę**, a APM jest
> realizowane **natywnie w Grafanie** (Tempo metrics-generator → RED + service graph,
> korelacja trace↔log↔metryka). Szczegóły: [`stack-proposal-grafana-apm.md`](stack-proposal-grafana-apm.md).
>
> W konsekwencji **żadne z trzech samodzielnych APM (SigNoz / SkyWalking / Uptrace)
> nie jest wybierane** — ani lokalnie, ani produkcyjnie. Ten dokument pozostaje jako
> analiza ścieżki „samodzielne APM", która została odrzucona, oraz uzasadnienie wyboru
> Grafany. Poniżej — dlaczego.

### Dlaczego Grafana zamiast samodzielnego APM

Kluczowy argument to **jedno narzędzie prod + local**. Skoro produkcja to Grafana,
postawienie obok niej osobnego APM (SigNoz) oznaczałoby:
- **dwa UI** i dwie konfiguracje do utrzymania (SigNoz + Grafana dla metryk infra),
- **rozjazd prod/local**, jeśli produkcja i tak konsoliduje się na Grafanie,
- dodatkowy **ClickHouse** (+2-4 GB RAM lokalnie) bez zysku wobec Tempo.

Grafana z Tempo metrics-generator domyka dokładnie te funkcje, dla których w ogóle
rozważano samodzielne APM: **automatyczny service map** i **metryki RED z trace'ów**.
Dochodzi natywna korelacja **metryka↔trace przez exemplary**, której SigNoz nie robi
dobrze. Świadomy kompromis: brak gotowego, grupującego **error-trackingu** w stylu
SigNoz — w Grafanie OSS odtwarzany zapytaniami po logach i statusie spanów.

### Gdyby jednak wybierać samodzielne APM — dlaczego SigNoz z trójki

Gdyby ścieżka „samodzielne APM" wróciła na stół, spośród trójki najlepszy byłby
**SigNoz**: licencja czysta (Apache 2.0), rosnąca społeczność, ClickHouse lżejszy od
Elasticsearch, OTel-native, traces + logi + metryki w jednym UI. Z zastrzeżeniem:
> Instrumentacja Magento wymaga pracy własnej i należy ją wycenić jako koszt wdrożenia.

### Poziom vs New Relic (dotyczy też Grafany)

**Żadne z rozwiązań open-source — w tym Grafana — nie jest dziś w pełni konkurencyjne
jakościowo do New Relic** dla złożonej architektury PHP. Traces i logi są zbliżone, ale
luka w profilingu kodu PHP, auto-instrumentacji i dojrzałości alertowania/RUM jest realna
niezależnie od wybranego backendu OTel.

### Dlaczego nie SkyWalking

Dla stosu PHP + Node.js SkyWalking jest nieodpowiedni ze względu na:
- Ciężką infrastrukturę (Elasticsearch jako domyślny storage)
- Historię Java-centric — PHP jest obywatelem drugiej kategorii
- Słabe wsparcie PHP agent i brak dokumentacji dla Magento
- Wyższy koszt operacyjny niż SigNoz

SkyWalking byłby właściwym wyborem dla architektury opartej głównie na Javie lub Go.

### Dlaczego nie Uptrace

- Mała społeczność — ryzyko przy długoterminowym utrzymaniu
- Licencja BSL 1.1 — wymaga analizy prawnej przed wdrożeniem produkcyjnym
- Zbyt mało dojrzały jak na rekomendację produkcyjną

---

## Powiązane dokumenty

- [`stack-proposal.md`](stack-proposal.md) — wariant stacku observability z Grafana Tempo + Loki
- [`stack-proposal-signoz.md`](stack-proposal-signoz.md) — wariant stacku observability z SigNoz
- [`stack-proposal-grafana-apm.md`](stack-proposal-grafana-apm.md) — wariant z Grafaną jako jedynym narzędziem (APM natywne w Grafanie)
