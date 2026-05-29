$IMAGE = "falcondb:latest"
$POD = "falcondb"
$LOGS = "$PWD\logs"

New-Item -ItemType Directory -Force -Path $LOGS | Out-Null
New-Item -ItemType Directory -Force -Path "$PWD\DBdata\dn0s1" | Out-Null
New-Item -ItemType Directory -Force -Path "$PWD\DBdata\dn0s2" | Out-Null
New-Item -ItemType Directory -Force -Path "$PWD\DBdata\dn0s3" | Out-Null
New-Item -ItemType Directory -Force -Path "$PWD\DBdata\dn1s1" | Out-Null
New-Item -ItemType Directory -Force -Path "$PWD\DBdata\dn1s2" | Out-Null
New-Item -ItemType Directory -Force -Path "$PWD\DBdata\dn1s3" | Out-Null
New-Item -ItemType Directory -Force -Path "$PWD\DBdata\dn2s1" | Out-Null
New-Item -ItemType Directory -Force -Path "$PWD\DBdata\dn2s2" | Out-Null
New-Item -ItemType Directory -Force -Path "$PWD\DBdata\dn2s3" | Out-Null

Write-Host "Building image..."
podman build -t $IMAGE .

Write-Host "Creating pod..."
podman pod create --name $POD -p 8000:8000

Write-Host "Starting RP..."
podman run -d --pod $POD --name rp `
  -v "${LOGS}:/app/logs" `
  $IMAGE node src/reverseProxy/server.js

Write-Host "Starting DN0..."
podman run -d --pod $POD --name dn0s1 `
  -v "${PWD}/DBdata/dn0s1:/app/DBdata" `
  -v "${LOGS}:/app/logs" `
  $IMAGE node src/dataNode/dn0s1/server.js

podman run -d --pod $POD --name dn0s2 `
  -v "${PWD}/DBdata/dn0s2:/app/DBdata" `
  -v "${LOGS}:/app/logs" `
  $IMAGE node src/dataNode/dn0s2/server.js

podman run -d --pod $POD --name dn0s3 `
  -v "${PWD}/DBdata/dn0s3:/app/DBdata" `
  -v "${LOGS}:/app/logs" `
  $IMAGE node src/dataNode/dn0s3/server.js

Write-Host "Starting DN1..."
podman run -d --pod $POD --name dn1s1 `
  -v "${PWD}/DBdata/dn1s1:/app/DBdata" `
  -v "${LOGS}:/app/logs" `
  $IMAGE node src/dataNode/dn1s1/server.js

podman run -d --pod $POD --name dn1s2 `
  -v "${PWD}/DBdata/dn1s2:/app/DBdata" `
  -v "${LOGS}:/app/logs" `
  $IMAGE node src/dataNode/dn1s2/server.js

podman run -d --pod $POD --name dn1s3 `
  -v "${PWD}/DBdata/dn1s3:/app/DBdata" `
  -v "${LOGS}:/app/logs" `
  $IMAGE node src/dataNode/dn1s3/server.js

Write-Host "Starting DN2..."
podman run -d --pod $POD --name dn2s1 `
  -v "${PWD}/DBdata/dn2s1:/app/DBdata" `
  -v "${LOGS}:/app/logs" `
  $IMAGE node src/dataNode/dn2s1/server.js

podman run -d --pod $POD --name dn2s2 `
  -v "${PWD}/DBdata/dn2s2:/app/DBdata" `
  -v "${LOGS}:/app/logs" `
  $IMAGE node src/dataNode/dn2s2/server.js

podman run -d --pod $POD --name dn2s3 `
  -v "${PWD}/DBdata/dn2s3:/app/DBdata" `
  -v "${LOGS}:/app/logs" `
  $IMAGE node src/dataNode/dn2s3/server.js

Write-Host ""
Write-Host "falconDB running -> http://localhost:8000"
Write-Host "Logs -> $LOGS"
