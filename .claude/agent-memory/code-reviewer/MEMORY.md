# Code Reviewer Memory — pg-connection-pool

- [Schema caps are advisory](pgcp-schema-caps-advisory.md) — token `schemas` allow-list gates only the DECLARED target schema, not what the SQL body can touch (qualified cross-schema access bypasses it)
