-- Karen's own special instructions (Rec 2e, Luis's Oct 21 recording; built
-- 2026-11-12): what the owner wants her to know or do that the app cannot
-- tell her, e.g. "Walk-ins welcome before noon" or "Always offer Dina first
-- for color". Read into each of her prompts (karen-instructions.js). Null is
-- none. Also in ensure-schema.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS karen_instructions text;
