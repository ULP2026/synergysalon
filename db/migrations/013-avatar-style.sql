-- The settings behind a drawn character, so the character maker can open a
-- saved one and change it. The picture itself is still staff_users.avatar
-- (a small PNG, like an uploaded photo), so every place that shows a face
-- keeps working without knowing a character from a photo. Null for a photo.
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS avatar_style jsonb;
