---
name: zombie-specialized-viewers
description: Extend Zombie modality viewers, playback adapters, and partitioned data access.
---

# Zombie specialized viewers

Specialized viewers should adapt their data to shared playback, plotting, and navigation components instead of creating another transport. Follow the modality's current data module for cache table ownership and partition shape. Resolve paths through the registry or a centralized adapter; browser DuckDB cannot glob virtual-hosted S3 prefixes reliably, so explicit partition reads may be needed.

Validate asset and partition identifiers before interpolating them into URLs or SQL. Select needed columns and reduce large traces before bringing them into the browser. Cancel or ignore stale asynchronous reads when the selected asset changes. Keep SWDB-specific cache access inside web/src/swdb and reuse other viewer behavior through adapters.

For a new modality source, inspect the producing biodata-cache table and validate the adapter with representative partitions and missing-data states.
