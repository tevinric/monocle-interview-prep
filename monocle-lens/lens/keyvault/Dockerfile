# =============================================================================
# lens — Key Vault secret bootstrapper
# =============================================================================
# A short-lived init container. It authenticates to Azure Key Vault with this
# app's service principal, pulls every LENS-* secret, and writes them
# onto the shared lens_secrets volume for the postgres and backend containers
# to read. It then exits 0; the other services wait for that exit before starting.
# =============================================================================
FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY fetch_secrets.py .

ENTRYPOINT ["python", "-u", "/app/fetch_secrets.py"]
