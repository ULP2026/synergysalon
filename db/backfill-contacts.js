/**
 * Give the bookings already in the diary the client record they never got.
 *
 *   node --env-file-if-exists=.env db/backfill-contacts.js           # shows
 *   node --env-file-if-exists=.env db/backfill-contacts.js --apply   # writes
 *
 * Until the booking path started creating contacts, an appointment made
 * through the booking link, or typed straight into New appointment, kept the
 * guest's name, email and phone on the appointment itself and linked them to
 * nobody. Those people are in the diary and not in Clients. This finds them.
 *
 * It shows what it would do and changes nothing unless you pass --apply, and
 * everything it does then happens in one transaction: either every booking
 * gets its client or none does.
 *
 * Two things it deliberately will not do.
 *
 * It does not touch a booking whose guest looks like a test -- a name
 * starting ZZ, or with TEST in it. The salon's own trial bookings are in
 * that set and they are not clients. They are listed at the end so that
 * skipping them is a decision you can see, not one hidden in a filter.
 *
 * It does not invent an identity. A booking with neither an email nor a
 * phone number cannot be matched to anybody or usefully created as anybody,
 * so it is reported and left alone.
 */
import pg from 'pg';

const apply = process.argv.includes('--apply');
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

/** A booking the salon made to try the system, not a guest. */
const isTest = (name) => /^\s*zz\b/i.test(name || '') || /\btest\b/i.test(name || '');

const client = new pg.Client({
  connectionString: url,
  ssl: url.includes('localhost') ? false : { rejectUnauthorized: false },
});
await client.connect();

try {
  const { rows: loose } = await client.query(
    `SELECT a.id, a.ref, a.tenant_id, a.guest_name, a.guest_email, a.guest_phone,
            a.starts_at, a.status, a.channel
       FROM appointments a
      WHERE a.contact_id IS NULL
      ORDER BY a.starts_at`,
  );

  const skipped = loose.filter((a) => isTest(a.guest_name));
  const nameless = loose.filter((a) => !isTest(a.guest_name) && !a.guest_email && !a.guest_phone);
  const workable = loose.filter((a) => !isTest(a.guest_name) && (a.guest_email || a.guest_phone));

  console.log(`${loose.length} appointments have no client attached.`);
  console.log(`  ${workable.length} can be matched or created`);
  console.log(`  ${skipped.length} look like the salon's own test bookings`);
  console.log(`  ${nameless.length} have neither an email nor a phone number`);

  if (apply) await client.query('BEGIN');

  // One person may have several of these. Matching each booking in turn, and
  // re-reading after every link, means the second booking finds the contact
  // the first one just made instead of making a twin.
  let matched = 0;
  let created = 0;
  const plan = [];

  for (const a of workable) {
    const email = (a.guest_email || '').trim().toLowerCase();
    const phone = (a.guest_phone || '').trim();

    const { rows: found } = await client.query(
      `SELECT id, name FROM contacts
        WHERE tenant_id = $1
          AND (($2 <> '' AND lower(email) = $2) OR ($3 <> '' AND phone = $3))
        ORDER BY created_at
        LIMIT 1`,
      [a.tenant_id, email, phone],
    );

    let contactId = found[0]?.id;
    if (contactId) {
      matched += 1;
      plan.push({ ref: a.ref, guest: a.guest_name, action: `linked to ${found[0].name}` });
    } else {
      created += 1;
      plan.push({ ref: a.ref, guest: a.guest_name, action: 'new client' });
      if (apply) {
        const { rows } = await client.query(
          `INSERT INTO contacts (tenant_id, name, email, phone, source, status)
           VALUES ($1, $2, $3, $4, $5, 'booked')
           RETURNING id`,
          [a.tenant_id, a.guest_name, email, phone,
            a.channel === 'staff' ? 'Front desk' : 'Online booking'],
        );
        contactId = rows[0].id;
      }
    }

    if (!apply || !contactId) continue;

    await client.query('UPDATE appointments SET contact_id = $2 WHERE id = $1', [a.id, contactId]);
    // The earliest booking they have, not the moment this script ran.
    await client.query(
      `UPDATE contacts
          SET status = CASE WHEN status IN ('new', 'contacted')
                            THEN 'booked'::contact_status ELSE status END,
              first_booked_at = LEAST(COALESCE(first_booked_at, $2), $2),
              updated_at = now()
        WHERE id = $1`,
      [contactId, a.starts_at],
    );
  }

  console.table(plan.slice(0, 50));
  if (plan.length > 50) console.log(`…and ${plan.length - 50} more`);
  console.log(`${matched} would be linked to someone already in Clients, ${created} created.`);

  if (skipped.length) {
    console.log('\nLeft alone, as test bookings:');
    console.table(skipped.map((a) => ({ ref: a.ref, guest: a.guest_name, when: a.starts_at })));
  }
  if (nameless.length) {
    console.log('\nLeft alone, no email and no phone number:');
    console.table(nameless.map((a) => ({ ref: a.ref, guest: a.guest_name, when: a.starts_at })));
  }

  if (apply) {
    await client.query('COMMIT');
    console.log('\nApplied.');
  } else {
    console.log('\nNothing was changed. Run it again with --apply to do it.');
  }
} catch (err) {
  if (apply) await client.query('ROLLBACK').catch(() => {});
  throw err;
} finally {
  await client.end();
}
