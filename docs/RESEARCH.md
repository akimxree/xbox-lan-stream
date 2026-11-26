# Исследование: как xHome доставляет видео и где проходит граница Microsoft

Документ фиксирует факты, на которых построен прототип. Все наблюдения сделаны
по открытому коду `xbox-xcloud-player` (commit из vendor-сборки) и поведению
`xHome`-эндпоинтов; официальной документации на протокол нет.

## 1. Последовательность установления сессии

```
Client (PC)                     Microsoft                         Xbox
    |                               |                               |
    |-- MSAL device code ---------->|                               |
    |<-- user token ----------------|                               |
    |-- XSTS (user.auth.xboxlive) ->|                               |
    |<-- xsts token ----------------|                               |
    |-- gssv login (xhome) -------->|                               |
    |<-- gsToken + region baseUri --|                               |
    |                               |                               |
    |-- GET /v6/servers/home ------>|-- discovery ----------------->|
    |<-- {serverId, powerState} ----|                               |
    |                               |                               |
    |-- POST /v5/sessions/home/play>|-- provision ---------------->|
    |<-- {sessionId, sessionPath} --|                               |
    |-- GET .../state (poll) ------>|                               |
    |<-- Provisioned / ReadyToConnect                              |
    |-- POST .../sdp (offer) ------>|-- offer ------------------->|
    |<-- answer SDP ----------------|<-- answer ------------------|
    |-- POST .../ice -------------->|<-- candidates -------------->|
    |<-- remote candidates ---------|                               |
    |-- POST .../connect (LPT) ---->|-- authorize --------------->|
    |                               |                               |
    |=========== SRTP/UDP media, direct L2 ======================>|
    |-- POST .../keepalive (30 s) ->|                               |
```

Ключевое: SDP/ICE идут через HTTPS к `*.gssv-play-prodxhome.xboxlive.com`, но
**media-пакеты в этот обмен не входят**. В коде клиента:

```ts
// src/player.ts
_peerConnection = new RTCPeerConnection({})   // никаких STUN/TURN
...
// src/lib/stream.ts
sendSDPOffer(offer)  // POST /sdp
sendIceCandidates()  // POST /ice
```

`new RTCPeerConnection({})` означает только host-кандидаты; STUN/TURN не
настроены, значит relay-путь через инфраструктуру клиента невозможен. Если
консоль и ПК в одном L2, выбирается приватная пара.

`src/lib/stats.ts` явно проверяет `isPrivateIP(report.address)` и ведёт
`_remoteIsLocal`. Наш HUD делает то же самое, но показывает результат
пользователю и блокирует не-LAN кандидаты.

## 2. Почему официальное приложение может выглядеть «облачным»

1. **Control plane** всегда облачный: вход, discovery, провижининг, SDP/ICE,
   keepalive. На глаз это выглядит как «стрим через Microsoft», хотя видео там
   не проходит.
2. **ICE может не найти host-пару**:
   * Chromium заменяет локальные IP на mDNS `.local`; Xbox не резолвит mDNS.
     Лечится `--disable-features=WebRtcHideLocalIpsWithMdns` (включено в
     `main.js`).
   * ПК и Xbox в разных подсетях/VLAN, включён AP/client isolation.
   * Windows Firewall блокирует входящий UDP.
   * Консоль предлагает только IPv6/Teredo (2001:...), и клиент уходит в WAN.
3. **Корпоративные сети** блокируют P2P, остаётся relay. В домашнем L2 это
   редкий случай, но HUD покажет `RELAY`/`WAN`.

## 3. Матрица путей доставки

| Путь | Задержка | Качество | Сложность | Доступность |
|---|---|---|---|---|
| xHome + прямой L2 (этот проект) | низкая (50–80 мс) | 1080p H.264, ~15–25 Mbps | средняя | работает на retail Series X |
| xHome + ICS/NAT | + software-хоп | то же | средняя | если есть второй NIC |
| xHome + relay/Teredo | высокая, нестабильная | зависит от канала | низкая | fallback |
| Dev Mode Direct Connect | — | — | высокая | **нет API захвата игры** |
| Свой хост на Xbox (Sunshine) | — | — | — | **невозможно** (нет desktop/encoder) |
| HDMI capture + NVENC | + capture/encode | 4K/HDR/HEVC | высокая | любой ПК с картой |
| xCloud | облачная | 1080p | низкая | подписка, не локально |

## 4. Dev Mode: что именно проверялось

* Dev Home / Device Portal даёт HTTPS-доступ к консоли (порт 11443) для
  deploy/debug UWP. Это не media API.
* UWP-приложение не может захватить чужую игру или весь экран; системный
  `AppCapture` предназначен для клипов/скриншотов.
* Dev Mode — отдельная партиция, retail-игры в ней не запускаются; нужен
  Partner Center, dev-сертификат доверен только в Dev Mode.
* Следовательно, «Direct Connect» нельзя использовать как потребительский
  IP-стриминг. Единственный хост — встроенный xHome.

## 5. Что происходит при старте (latency budget)

Старт сессии — секунды (сеть + провижининг), но это не latency кадра. После
`connected` задержка складывается из:

1. Захват и энкодер консоли: 1–2 кадра (16–33 мс при 60 fps).
2. Очередь сети: <1 мс на гигабитном L2.
3. Jitter buffer WebRTC: 0–10 мс (мы просим минимум через
   `playoutDelayHint=0`).
4. Декодер: 1–3 мс на 1080p H.264 (NVDEC/QSV/AMF).
5. Compositor/vsync: 0–16.7 мс.
6. Дисплей: 5–10 мс.

Итого ~40–80 мс. «2 мс» — только пункт 4.

## 6. План экспериментов

1. **Path**: HUD `path` = `LAN` и `remote` — приватный IP. Wireshark на
   Xbox-интерфейсе: `udp && ip.addr == <xbox>`; убедиться, что нет видеопотока
   на IP Microsoft.
2. **RTT**: сравнить `RTT` HUD с ICMP; расхождение ожидаемо (разные протоколы).
3. **Decode**: `decode` < 3 мс; если 10–20 мс — декод программный (проверить
   `chrome://gpu`, драйвер, `--enable-accelerated-video-decode`).
4. **Jitter**: `buffer` > 20 мс на кабеле — признак перегрузки/ретраев; проверить
   NIC offload, interrupt moderation, фоновый трафик.
5. **Loss**: `loss` > 0.1% на L2 — плохой кабель/порт/драйвер, не «облако».
6. **Glass-to-glass**: камера 240 fps снимает экран Xbox и монитор; разница
   минус input lag камеры. Это единственный честный e2e-замер.

## 7. Риски

| Риск | Влияние | Митигация |
|---|---|---|
| Microsoft меняет xHome API | клиент перестаёт стартовать | следить за Greenlight; изолировать API-слой |
| Блокировка неофициального клиента | аккаунт | не автоматизировать, не публиковать токены |
| mDNS/ICE → WAN | +задержка, трафик | LAN-фильтр, флаг Chromium, HUD-тревога |
| ICS/NAT недоступны | нет выделенного сегмента | прямой L2/свитч; NAT fallback |
| VPN/Radmin/Teredo | неправильный candidate | фильтр RFC1918, отключить VPN на время |
| Ограничение кодека/битрейта | качество | принять; 4K только через capture card |

## 8. Ссылки на код

* `xbox-xcloud-player/src/player.ts` — `RTCPeerConnection({})`.
* `xbox-xcloud-player/src/lib/stream.ts` — `/sdp`, `/ice`, `/connect`.
* `xbox-xcloud-player/src/lib/stats.ts` — `isPrivateIP`, `currentRoundTripTime`.
* `xbox-xcloud-player/src/apiclient.ts` — `/v6/servers/home`,
  `/v5/sessions/home/play`, device-info, `enableOptionalDataCollection:false`.
* `xal-node/src/msal.ts` — device code, XSTS, gssv tokens.
* `greenlight` — эталонная Electron-обёртка.