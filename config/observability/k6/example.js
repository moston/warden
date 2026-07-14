// Przykladowy test obciazeniowy k6 — szablon do dostosowania per serwis/flow.
//
// Uruchomienie (wyniki -> Prometheus -> Grafana):
//   docker compose -p warden --project-directory ~/.warden \
//     -f <repo>/docker/docker-compose.observability.yml \
//     run --rm -e BASE_URL=https://app.master.test -e ENV_NAME=master \
//     k6 run -o experimental-prometheus-rw /scripts/example.js
//
// Metryki taguja sie env_name => w Grafanie porownasz master vs release-2-5
// na jednym wykresie (obok RED z Tempo i QAN z PMM dla tego samego env_name).

import http from 'k6/http';
import { check, sleep } from 'k6';

const ENV_NAME = __ENV.ENV_NAME || 'master';
const BASE_URL = __ENV.BASE_URL || `https://app.${ENV_NAME}.test`;

export const options = {
  // ramp-up -> obciazenie -> ramp-down; dostosuj do swojego SLA
  stages: [
    { duration: '1m', target: 10 },
    { duration: '3m', target: 50 },
    { duration: '1m', target: 0 },
  ],
  tags: { env_name: ENV_NAME }, // label na wszystkich metrykach tego runu
  thresholds: {
    http_req_duration: ['p(95)<3000'], // p95 < 3s
    http_req_failed: ['rate<0.01'],    // < 1% bledow
  },
  // ostrzezenia o niezweryfikowanym certyfikacie *.test sa oczekiwane lokalnie
  insecureSkipTLSVerify: true,
};

export default function () {
  const res = http.get(`${BASE_URL}/`);
  check(res, {
    'status is 2xx/3xx': (r) => r.status >= 200 && r.status < 400,
  });
  sleep(1);
}

// ── Przyklad realnego flow Magento (do odkomentowania i dopasowania) ──────
// export default function () {
//   const login = http.post(`${BASE_URL}/api/auth/login`, {
//     username: 'handlowiec@3w.pl', password: 'test',
//   });
//   check(login, { 'login OK': (r) => r.status === 200 });
//   const headers = { Authorization: `Bearer ${login.json('token')}` };
//   http.get(`${BASE_URL}/api/quotes?page=1&limit=20`, { headers });
//   sleep(1);
//   http.post(`${BASE_URL}/api/quotes`, JSON.stringify({
//     customer_id: 12345, items: [{ sku: 'PROD-001', qty: 10 }],
//   }), { headers, contentType: 'application/json' });
//   sleep(2);
// }
