# Comparativa de oráculos para activos bursátiles (borrador)

> Estado: borrador. Los datos marcados ✅ se verificaron directamente durante la PoC;
> el resto debe confirmarse en la documentación oficial antes de cerrar el criterio 1.

## Pyth Network

- ✅ Feed `Equity.US.AAPL/USD`, ID `0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688`
  (consultado el 2026-10-26 en `hermes.pyth.network/v2/price_feeds`).
- ✅ Existe además `Equity.Index.AAPL/USD` ("PYTH PRICE IN USD FOR APPLE 24/7"): precio 24/7,
  relevante para el modelo sintético. Falta investigar cómo se construye fuera de horario.
- ✅ Los metadatos incluyen `schedule` (zona `America/New_York`, sesión 09:30-16:00, feriados y
  medias jornadas) y `market_hours` (`is_open`, `next_open`, `next_close`). Este endpoint no pide credenciales.
- ✅ `min_channel: fixed_rate@50ms`: frecuencia de publicación de la fuente.
- ✅ El endpoint de precios firmados (`/v2/updates/price/latest`) devuelve **401**: requiere API key
  (se obtiene en Pyth Terminal, https://pythdata.app/signup; la prueba gratuita incluye cripto).
- ✅ Con una key de prueba (2026-10-28): ETH/USD responde, pero `Equity.US.AAPL/USD` devuelve
  **403 "Not entitled"** (asset type `equity`) y `Equity.Index.AAPL/USD` exige el grupo `pyth-indices`.
  **Los datos de acciones requieren un permiso o plan adicional.**
- ✅ Lectura on-chain sin key (`getPriceUnsafe`, 2026-10-28). Los precios existen, pero nadie los actualiza:

  | Red          | Precio AAPL | Publicado              | Antigüedad |
  |--------------|-------------|------------------------|------------|
  | Base Sepolia | 312.49      | 2026-08-26 16:01 UTC   | 63 días    |
  | Base mainnet | 308.56      | 2026-07-02 20:00 UTC   | 118 días   |
  | Arbitrum One | 266.48      | 2026-04-27 18:00 UTC   | 184 días   |

  Con el modelo pull, el precio on-chain solo avanza si alguien llama a `updatePriceFeeds`.
  El último dato en Base Sepolia coincide con el cambio a API keys obligatorias (2026-08-26 16:00 UTC).
  `OracleAdapter` clasificaría estos precios como `Stale`: es un caso real del criterio 4.
- ✅ Flujo pull completo validado con ETH/USD en Base Sepolia (`script/onchain-check.mjs`, 2026-10-28, solo `eth_call`):

  | Paso                                   | Resultado                                              |
  |----------------------------------------|--------------------------------------------------------|
  | Precio on-chain antes de actualizar    | 2696.01, publicado 2026-10-01 (hace 27 días)           |
  | Precio en vivo en Hermes               | 2355.34, publicado hace 1 s                            |
  | `getUpdateFee`                         | 10 wei por actualización                               |
  | `updatePriceFeeds` (simulado)          | Aceptado: la firma es válida                           |
  | `updatePriceFeeds` con 1 byte alterado | Rechazado (`0x2acbe915`)                               |

  **Lectura de riesgo:** el precio guardado on-chain difería **12.6 %** del precio real. Una bóveda
  que lo leyera sin validar `publishTime` valoraría mal sus participaciones. Por eso
  `OracleAdapter` controla la antigüedad (`maxAge` / `maxClosedAge`).
- Modelo **pull**: el precio firmado se envía al contrato con `updatePriceFeeds` (pagando una tarifa) y se lee con `getPriceUnsafe` o `getPriceNoOlderThan`.
- On-chain **no** expone el estado del mercado: el contrato solo ve `publishTime`. Por eso
  `OracleAdapter` lleva un calendario propio y un cierre forzado para feriados.
- Fuente: publishers primarios (exchanges, market makers). *Por confirmar cuáles publican acciones de EE. UU.*

## Chainlink

- Data Feeds (push): pocos pares de acciones. *Por confirmar redes y vigencia.*
- Data Streams para RWA / US equities: incluye estado del mercado en el reporte. *Por confirmar el esquema y el acceso (requiere solicitud).*

## RedStone

- Feeds de acciones con modelos push y pull. *Por confirmar cobertura y testnets.*

## Matriz (completar)

| Criterio                    | Pyth                         | Chainlink Data Streams | RedStone |
|-----------------------------|------------------------------|------------------------|----------|
| Fuente del precio           | Publishers primarios         | ?                      | ?        |
| Frecuencia                  | 50 ms (off-chain)            | ?                      | ?        |
| Estado del mercado on-chain | No (solo `publishTime`)      | ? (reporte RWA)        | ?        |
| Horario / feriados          | Sí, en metadatos off-chain   | ?                      | ?        |
| Precio 24/7                 | Sí (`Equity.Index.*`)        | ?                      | ?        |
| Acceso en testnet           | Sí (requiere API key Hermes) | Requiere solicitud     | ?        |
