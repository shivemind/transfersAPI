#!/bin/zsh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ACCOUNTS_REPO_DIR="${ACCOUNTS_REPO_DIR:-$ROOT_DIR/../accountsAPI}"
LEDGER_REPO_DIR="${LEDGER_REPO_DIR:-$ROOT_DIR/../ledgerAPI}"
GRAPH_NAMESPACE="${GRAPH_NAMESPACE:-postman-api-graph}"
K3D_CLUSTER_NAME="${K3D_CLUSTER_NAME:-postman-api-graph}"
POSTMAN_SECRET_NAMESPACE="postman-insights-namespace"
SERVICE_REPOS=("$ROOT_DIR" "$ACCOUNTS_REPO_DIR" "$LEDGER_REPO_DIR")
K3D_AGENT_COUNT="${K3D_AGENT_COUNT:-${#SERVICE_REPOS[@]}}"
K3D_API_PORT="${K3D_API_PORT:-$(node -e 'const net = require("node:net"); const server = net.createServer(); server.listen(0, "127.0.0.1", () => { console.log(server.address().port); server.close(); });')}"

function require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

function build_and_import_image() {
  local repo_dir="$1"
  local image_name

  image_name="$(node -e 'const fs = require("node:fs"); const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); const graph = manifest.services[0].graph || {}; console.log(graph.image || `${manifest.services[0].service_key}:dev`);' "$repo_dir/postman-services.json")"

  echo "Building image ${image_name} from ${repo_dir}"
  docker build -t "${image_name}" "${repo_dir}"
  k3d image import "${image_name}" -c "${K3D_CLUSTER_NAME}"
}

function render_bundle() {
  local repo_dir="$1"
  local include_agent="$2"
  (cd "$repo_dir" && node scripts/render-runtime-bundle.mjs --namespace "${GRAPH_NAMESPACE}" --output-dir k8s/rendered --include-agent "${include_agent}")
}

require_command docker
require_command kubectl
require_command node
require_command k3d

for repo_dir in "${SERVICE_REPOS[@]}"; do
  if [[ ! -f "$repo_dir/postman-services.json" ]]; then
    echo "Missing postman-services.json in ${repo_dir}" >&2
    exit 1
  fi
done

if k3d cluster list | awk '{print $1}' | grep -qx "${K3D_CLUSTER_NAME}"; then
  kubectl config use-context "k3d-${K3D_CLUSTER_NAME}" >/dev/null 2>&1 || true
  CURRENT_NODE_COUNT="$(kubectl get nodes --no-headers 2>/dev/null | wc -l | tr -d ' ')"
  REQUIRED_NODE_COUNT="$((K3D_AGENT_COUNT + 1))"

  if [[ "${CURRENT_NODE_COUNT:-0}" -lt "${REQUIRED_NODE_COUNT}" ]]; then
    echo "Recreating k3d cluster ${K3D_CLUSTER_NAME} with ${K3D_AGENT_COUNT} agents so graph services can land on distinct nodes"
    k3d cluster delete "${K3D_CLUSTER_NAME}"
  fi
fi

if ! k3d cluster list | awk '{print $1}' | grep -qx "${K3D_CLUSTER_NAME}"; then
  echo "Creating k3d cluster ${K3D_CLUSTER_NAME} with ${K3D_AGENT_COUNT} agents on API port ${K3D_API_PORT}"
  k3d cluster create "${K3D_CLUSTER_NAME}" --servers 1 --agents "${K3D_AGENT_COUNT}" --no-lb --api-port "127.0.0.1:${K3D_API_PORT}" --wait
fi

kubectl config use-context "k3d-${K3D_CLUSTER_NAME}" >/dev/null
kubectl get namespace "${GRAPH_NAMESPACE}" >/dev/null 2>&1 || kubectl create namespace "${GRAPH_NAMESPACE}"

render_bundle "$ROOT_DIR" true
render_bundle "$ACCOUNTS_REPO_DIR" false
render_bundle "$LEDGER_REPO_DIR" false

if [[ -n "${POSTMAN_API_KEY:-}" ]]; then
  kubectl get namespace "${POSTMAN_SECRET_NAMESPACE}" >/dev/null 2>&1 || kubectl create namespace "${POSTMAN_SECRET_NAMESPACE}"
  kubectl -n "${POSTMAN_SECRET_NAMESPACE}" delete secret postman-agent-secrets >/dev/null 2>&1 || true
  kubectl -n "${POSTMAN_SECRET_NAMESPACE}" create secret generic postman-agent-secrets --from-literal=postman-api-key="${POSTMAN_API_KEY}"
fi

for repo_dir in "${SERVICE_REPOS[@]}"; do
  build_and_import_image "$repo_dir"
done

kubectl apply -f "$ROOT_DIR/k8s/rendered/transfers-api.service.yaml"
kubectl apply -f "$ACCOUNTS_REPO_DIR/k8s/rendered/accounts-api.service.yaml"
kubectl apply -f "$LEDGER_REPO_DIR/k8s/rendered/ledger-api.service.yaml"
kubectl apply -f "$ROOT_DIR/k8s/rendered/transfers-api.traffic.yaml"

if [[ -n "${POSTMAN_API_KEY:-}" ]]; then
  kubectl apply -f "$ROOT_DIR/k8s/rendered/postman-insights-agent.yaml"
else
  echo "POSTMAN_API_KEY is not set, so the Insights agent manifest was rendered but not applied."
fi

kubectl rollout status deployment/transfers-api -n "${GRAPH_NAMESPACE}"
kubectl rollout status deployment/accounts-api -n "${GRAPH_NAMESPACE}"
kubectl rollout status deployment/ledger-api -n "${GRAPH_NAMESPACE}"

echo "Graph stack is deployed to cluster k3d-${K3D_CLUSTER_NAME} in namespace ${GRAPH_NAMESPACE}."
echo "If POSTMAN_API_KEY was set, check the agent with:"
echo "  kubectl get pods -n ${POSTMAN_SECRET_NAMESPACE}"
echo "  kubectl logs -n ${POSTMAN_SECRET_NAMESPACE} daemonset/postman-insights-agent --tail=20"
