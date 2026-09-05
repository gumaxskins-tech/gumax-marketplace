# Risk engine

Risk decisions are `ALLOW`, `REVIEW`, or `BLOCK`, and must retain the triggering signals. `RiskEvent`, `TrustScore`, KYC records, payment events and trade events are durable input sources. Thresholds and policies are versioned configuration, not code constants.
