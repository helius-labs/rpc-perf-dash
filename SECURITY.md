# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately via GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
("Report a vulnerability" under this repository's **Security** tab). Do not
open a public issue for security reports.

We'll acknowledge reports within a few business days. Please include enough
detail to reproduce the issue (affected component, steps, impact).

## Scope notes

- This repository contains no credentials. Provider API keys, database URLs,
  and account identifiers are supplied via environment variables / secret
  managers at deploy time. If you find anything that looks like a live
  credential or internal identifier in the tree or history, that itself is a
  reportable issue.
- The benchmark methodology (consensus rules, anti-gaming defenses) is
  documented in `docs/methodology.md`. Reports demonstrating a practical way
  for a benchmarked provider to detect or game benchmark traffic are in scope
  and very welcome.
