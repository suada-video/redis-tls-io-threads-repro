#!/usr/bin/env bash
set -euo pipefail

CERT_DIR="./certs"
mkdir -p "$CERT_DIR"

echo "Generating self-signed TLS certificates for Redis..."

# CA
openssl genrsa -out "$CERT_DIR/ca.key" 4096
openssl req -x509 -new -nodes -key "$CERT_DIR/ca.key" -sha256 -days 365 \
  -out "$CERT_DIR/ca.crt" -subj "/CN=Redis Test CA"

# Server cert (Redis)
openssl genrsa -out "$CERT_DIR/server.key" 2048
openssl req -new -key "$CERT_DIR/server.key" \
  -out "$CERT_DIR/server.csr" -subj "/CN=redis"
cat > "$CERT_DIR/server.ext" <<EOF
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage=digitalSignature, keyEncipherment
subjectAltName=DNS:redis,DNS:localhost,IP:127.0.0.1
EOF
openssl x509 -req -in "$CERT_DIR/server.csr" -CA "$CERT_DIR/ca.crt" \
  -CAkey "$CERT_DIR/ca.key" -CAcreateserial -out "$CERT_DIR/server.crt" \
  -days 365 -sha256 -extfile "$CERT_DIR/server.ext"

# Client cert (for mTLS)
openssl genrsa -out "$CERT_DIR/client.key" 2048
openssl req -new -key "$CERT_DIR/client.key" \
  -out "$CERT_DIR/client.csr" -subj "/CN=redis-client"
cat > "$CERT_DIR/client.ext" <<EOF
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage=digitalSignature, keyEncipherment
EOF
openssl x509 -req -in "$CERT_DIR/client.csr" -CA "$CERT_DIR/ca.crt" \
  -CAkey "$CERT_DIR/ca.key" -CAcreateserial -out "$CERT_DIR/client.crt" \
  -days 365 -sha256 -extfile "$CERT_DIR/client.ext"

# Clean up CSRs
rm -f "$CERT_DIR"/*.csr "$CERT_DIR"/*.ext "$CERT_DIR"/*.srl

echo "Certificates generated in $CERT_DIR/"
ls -la "$CERT_DIR/"
