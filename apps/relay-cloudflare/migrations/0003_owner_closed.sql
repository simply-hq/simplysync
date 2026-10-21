-- Marks an owner retired via POST /v1/owner/close (leaked recovery phrase).
-- The row stays so the old token can never recreate the owner on next push.
alter table owners add column closed_at text;
