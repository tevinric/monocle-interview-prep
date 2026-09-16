# Convenience wrappers only — docker-compose.yml remains the source of truth.
#
# `make up` needs the four LENS_AZURE_* bootstrap variables in the shell
# (source ./lens_kv_init.sh). Every other target runs against an already-started
# stack and does not touch the vault, so it fills those four with placeholders
# purely to satisfy compose's interpolation checks.

KV_PLACEHOLDERS = LENS_AZURE_KEYVAULT_URL=$${LENS_AZURE_KEYVAULT_URL:-unused} \
                  LENS_AZURE_TENANT_ID=$${LENS_AZURE_TENANT_ID:-unused} \
                  LENS_AZURE_CLIENT_ID=$${LENS_AZURE_CLIENT_ID:-unused} \
                  LENS_AZURE_CLIENT_SECRET=$${LENS_AZURE_CLIENT_SECRET:-unused}
DC = $(KV_PLACEHOLDERS) docker compose
DB_IN_CONTAINER = -U "$$(cat /secrets/parts/LENS-DB-USER)" -d "$$(cat /secrets/parts/LENS-DB-NAME)"
# `docker compose exec` starts a process without the image's ENTRYPOINT, so a command run
# that way would never load the Key Vault credentials. Invoke the entrypoint explicitly.
RUN_IN_BACKEND = $(DC) exec backend /app/entrypoint.sh

.PHONY: up up-offline logs check-model check-auth ingest eval seed record down psql

up:
	@test -n "$$LENS_AZURE_KEYVAULT_URL" || { echo "LENS_AZURE_* not set — run: source ./lens_kv_init.sh"; exit 1; }
	docker compose up --build -d

# Starts with no network access to the vault or OpenAI: skips keyvault-init and reuses the
# lens_secrets volume written by the last successful online start, with demo mode on.
# Refuses if that volume was never populated.
up-offline:
	@docker volume inspect lens_secrets >/dev/null 2>&1 \
	  || { echo "lens_secrets does not exist — run 'make up' online once first."; exit 1; }
	@docker run --rm -v lens_secrets:/s:ro --entrypoint test pgvector/pgvector:pg16 -f /s/backend.env \
	  || { echo "lens_secrets has no credentials yet — run 'make up' online once first."; exit 1; }
	LENS_DEMO_MODE=true $(DC) up --build -d --no-deps postgres backend frontend

logs:
	$(DC) logs -f backend

# Proves the configured models answer, with the parameters this app actually sends.
# Run it once after adding your API key, before spending anything on ingest.
check-model:
	$(RUN_IN_BACKEND) python -m lens.selftest

# Proves the Entra configuration is real and that the validator rejects every kind of
# wrong token. Safe to run any time: no real token is needed and nothing is written.
check-auth:
	$(RUN_IN_BACKEND) python -m lens.authcheck

ingest:
	$(RUN_IN_BACKEND) python -m lens.ingest.cli --all

eval:
	$(RUN_IN_BACKEND) python -m lens.evals.run

seed:
	$(RUN_IN_BACKEND) python -m lens.demo.seed

# Needs a live OpenAI key: runs the demo questions and saves the model responses
# that demo mode replays.
record:
	$(RUN_IN_BACKEND) python -m lens.demo.record

down:
	$(DC) down

psql:
	$(DC) exec postgres sh -c 'psql $(DB_IN_CONTAINER)'
