Write-Host "Stopping pod falcondb..."
podman pod stop falcondb
podman pod rm falcondb

Write-Host "Done."
