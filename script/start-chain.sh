#!/usr/bin/env bash
# Levanta la blockchain local (copia de Base Sepolia con el contrato real de Pyth) y despliega la demo.
# Uso (WSL / Linux / macOS):  ./script/start-chain.sh
# Ctrl+C detiene la blockchain. Cada arranque empieza desde cero.
set -euo pipefail
cd "$(dirname "$0")/.."

FORK_URL="${BASE_SEPOLIA_RPC_URL:-https://sepolia.base.org}"
RPC=http://127.0.0.1:8545
# Cuenta 0 de Anvil (pública y conocida, solo para desarrollo local)
ADMIN_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

echo "Iniciando Anvil (fork de $FORK_URL)..."
anvil --fork-url "$FORK_URL" --chain-id 31337 --block-time 2 --host 0.0.0.0 --silent &
ANVIL_PID=$!
trap 'kill $ANVIL_PID 2>/dev/null' EXIT

until cast chain-id --rpc-url $RPC >/dev/null 2>&1; do sleep 1; done

echo "Desplegando contratos..."
forge script script/Deploy.s.sol --rpc-url $RPC --broadcast --private-key $ADMIN_KEY 2>&1 \
  | grep -E "mUSDC|Vault|MockPyth|SUCCESSFUL|Error"

echo
echo "Listo. Blockchain local en $RPC (chain id 31337)."
echo "En otra terminal:  node --env-file=.env app/server.mjs   ->  http://localhost:3000"
echo "Ctrl+C para detener."
wait $ANVIL_PID
