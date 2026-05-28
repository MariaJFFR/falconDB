$IMAGE = "falcondb:latest"
$POD = "falcondb"
$LOGS = "$PWD\logs"

New-Item -ItemType Directory -Force -Path $LOGS | Out-Null

Write-Host "Building image..."
podman build -t $IMAGE .

Write-Host "Creating pod..."
podman pod create --name $POD -p 8000:8000

Write-Host "Starting RP..."
podman run -d --pod $POD --name rp `
  -v "${LOGS}:/app/logs" `
  $IMAGE node RP/server.js

Write-Host "Starting dn0s1..."
podman run -d --pod $POD --name dn0s1 `
  -v "falcondb-dn0s1:/app/DBdata" `
  -v "${LOGS}:/app/logs" `
  $IMAGE node DN/dn0s1/server.js

Write-Host "Starting dn0s2..."
podman run -d --pod $POD --name dn0s2 `
  -v "falcondb-dn0s2:/app/DBdata" `
  -v "${LOGS}:/app/logs" `
  $IMAGE node DN/dn0s2/server.js

Write-Host "Starting dn0s3..."
podman run -d --pod $POD --name dn0s3 `
  -v "falcondb-dn0s3:/app/DBdata" `
  -v "${LOGS}:/app/logs" `
  $IMAGE node DN/dn0s3/server.js

Write-Host ""
Write-Host "falconDB running -> http://localhost:8000"
Write-Host "Logs -> $LOGS"
