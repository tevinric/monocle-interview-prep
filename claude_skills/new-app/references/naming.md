# Naming derivation

`scaffold.sh` takes **one** app name and derives the forms the skeleton needs. The
name is normalised first: lowercased, spaces/hyphens → `_`, non-alphanumeric
stripped, underscores collapsed.

## Placeholder tokens in the skeleton

The bundled skeleton uses three literal placeholder tokens, replaced in every text
file at scaffold time:

| Token | Derived from `acme_crm` | Used for |
|-------|-------------------------|----------|
| `@@SLUG@@` | `acme_crm` | container/volume/network names, DB name/user, package name |
| `@@PREFIX@@` | `ACMECRM` | every environment variable (`ACMECRM_DB_NAME`, …) |
| `@@NAME@@` | `Acme CRM` | UI display name, page `<title>`, README headings |

## Derivation rules

- **`@@SLUG@@`** = normalised snake name (`"Acme CRM"` / `acme-crm` → `acme_crm`).
- **`@@PREFIX@@`** = slug uppercased with underscores removed (`acme_crm` → `ACMECRM`).
- **`@@NAME@@`** = `--display` if given, else the slug title-cased (`acme_crm` → `Acme Crm`).

Container names are `<slug>_db`, `<slug>_backend`, `<slug>_frontend`; the volume is
`<slug>_pg_data`; the network is `<slug>_net`. Every env var is `<PREFIX>_...`.

## Notes

- Substitution is applied to text files only (binaries are skipped), so it can't
  corrupt any binary asset.
- The tokens are distinct and non-overlapping, so replacement order doesn't matter.
