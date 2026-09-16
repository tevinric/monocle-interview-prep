FROM python:3.11-slim

RUN apt-get update && apt-get install -y \
    gcc \
    libpq-dev \
    postgresql-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# tiktoken downloads its encodings on first use. Bake them into the image so token
# counting works in demo mode with no network.
ENV TIKTOKEN_CACHE_DIR=/opt/tiktoken
RUN python -c "import tiktoken; tiktoken.get_encoding('cl100k_base'); tiktoken.get_encoding('o200k_base')"

COPY . .

# Loads the Key Vault credentials written by keyvault-init, then execs CMD.
RUN chmod +x /app/entrypoint.sh

EXPOSE 5000

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["gunicorn", "--config", "gunicorn_config.py", "app:app"]
