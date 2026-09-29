import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const k = await c.query(`SELECT id, name, email, session_id, ghl_contact_id, status
  FROM contacts WHERE name = 'ZZ Live Check'`);
console.log('contacts created:', k.rows.length, '(expected 1)');
for (const r of k.rows) console.log('  ', r.email, '| session', (r.session_id||'').slice(0,16), '| ghl=' + (r.ghl_contact_id || 'PENDING'), '|', r.status);
const a = await c.query(`SELECT a.ref, a.starts_at, a.status, a.ghl_appointment_id, s.name stylist, v.name service, a.notes
  FROM appointments a JOIN stylists s ON s.id=a.stylist_id JOIN services v ON v.id=a.service_id
  WHERE a.guest_name = 'ZZ Live Check'`);
console.log('appointments created:', a.rows.length, '(expected 1)');
for (const r of a.rows) {
  console.log('  ', r.ref, '|', r.starts_at.toISOString(), '|', r.service, 'with', r.stylist, '| ghl=' + (r.ghl_appointment_id || 'PENDING'));
  console.log('   notes carried through:'); for (const l of (r.notes||'').split('\n')) console.log('     ', l);
}
const o = await c.query(`SELECT kind, state, attempts, COALESCE(last_error,'') err FROM sync_outbox
  WHERE created_at > now() - interval '5 minutes' ORDER BY created_at`);
console.log('sync jobs:', o.rows.map(r => `${r.kind}=${r.state}${r.err ? ' ('+r.err.slice(0,90)+')' : ''}`).join(', ') || 'none');
await c.end();
