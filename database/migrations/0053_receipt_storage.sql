-- Keep the exact provider response for recovery and audit, with one physical representation.
-- Enable RECEIPT_COMPRESSION_ENABLED only after every reader has upgraded.
ALTER TABLE receipts ADD COLUMN response_compressed bytea;
ALTER TABLE receipts ADD COLUMN response_storage_checked boolean NOT NULL DEFAULT false;
ALTER TABLE receipts ADD CONSTRAINT receipts_response_storage_check
  CHECK (response_compressed IS NULL OR response IS NULL);
CREATE INDEX receipts_compaction_idx ON receipts (id)
  WHERE status = 'completed' AND NOT response_storage_checked;
COMMENT ON COLUMN receipts.response_compressed IS 'gzip UTF-8 JSON; decoded by providers/receipt-storage.ts';
COMMENT ON COLUMN receipts.response_storage_checked IS 'Prevents repeatedly scanning responses that do not benefit from compression';
