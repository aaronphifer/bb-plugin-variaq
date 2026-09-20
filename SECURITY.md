# Security policy

## Scope

The plugin invokes the configured local Python interpreter as
`python -m variaq`. It passes validated argv arrays directly to the process
with `shell: false`, captures bounded stdout/stderr, and enforces a configurable
timeout. Configured paths must be absolute; the Python executable and VariaQ
checkout are validated before use.

The plugin requires no API credentials, contains no analytics or telemetry,
and has no physical-QPU, IBM Runtime/provider, or other remote execution path.
It does not intentionally include environment values in errors.

Any future remote service, provider credential, or physical-QPU integration
requires a separate explicit security and privacy review before implementation.

## Reporting

When a public repository exists, use GitHub private vulnerability reporting if
it is enabled. Otherwise contact the repository owner privately through their
published profile contact. Do not include active secrets or sensitive system
data in a public issue. No project-specific private security email is currently
published.
