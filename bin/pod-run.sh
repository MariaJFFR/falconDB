#!/bin/bash

IMAGE="falcondb:latest"
POD="falcondb"
LOGS="$(pwd)/logs"

mkdir -p "$LOGS"
mkdir -p "$(pwd)/DBdata/dn0"
mkdir -p "$(pwd)/DBdata/dn1"
mkdir -p "$(pwd)/DBdata/dn2"

echo "Building image..."
podman build -t $IMAGE .

echo "Creating pod..."
podman pod create --name $POD -p 8000:8000

echo "Starting RP..."
podman run -d --pod $POD --name rp \
  -v "$LOGS":/app/logs \
  $IMAGE node src/reverseProxy/server.js

echo "Starting DN0..."
podman run -d --pod $POD --name dn0s1 \
  -v "$(pwd)/DBdata/dn0:/app/DBdata" \
  -v "$LOGS":/app/logs \
  $IMAGE node src/dataNode/dn0s1/server.js

podman run -d --pod $POD --name dn0s2 \
  -v "$(pwd)/DBdata/dn0:/app/DBdata" \
  -v "$LOGS":/app/logs \
  $IMAGE node src/dataNode/dn0s2/server.js

podman run -d --pod $POD --name dn0s3 \
  -v "$(pwd)/DBdata/dn0:/app/DBdata" \
  -v "$LOGS":/app/logs \
  $IMAGE node src/dataNode/dn0s3/server.js

echo "Starting DN1..."
podman run -d --pod $POD --name dn1s1 \
  -v "$(pwd)/DBdata/dn1:/app/DBdata" \
  -v "$LOGS":/app/logs \
  $IMAGE node src/dataNode/dn1s1/server.js

podman run -d --pod $POD --name dn1s2 \
  -v "$(pwd)/DBdata/dn1:/app/DBdata" \
  -v "$LOGS":/app/logs \
  $IMAGE node src/dataNode/dn1s2/server.js

podman run -d --pod $POD --name dn1s3 \
  -v "$(pwd)/DBdata/dn1:/app/DBdata" \
  -v "$LOGS":/app/logs \
  $IMAGE node src/dataNode/dn1s3/server.js

echo "Starting DN2..."
podman run -d --pod $POD --name dn2s1 \
  -v "$(pwd)/DBdata/dn2:/app/DBdata" \
  -v "$LOGS":/app/logs \
  $IMAGE node src/dataNode/dn2s1/server.js

podman run -d --pod $POD --name dn2s2 \
  -v "$(pwd)/DBdata/dn2:/app/DBdata" \
  -v "$LOGS":/app/logs \
  $IMAGE node src/dataNode/dn2s2/server.js

podman run -d --pod $POD --name dn2s3 \
  -v "$(pwd)/DBdata/dn2:/app/DBdata" \
  -v "$LOGS":/app/logs \
  $IMAGE node src/dataNode/dn2s3/server.js

echo ""
echo "falconDB running -> http://localhost:8000"
echo "Logs -> $LOGS"
