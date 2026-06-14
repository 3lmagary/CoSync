const Database = require('better-sqlite3');
const Y = require('yjs');

const db = new Database('/mnt/workspace/CoSync/backend/data/sync.db');
const docId = 'doc-h9h5kinhmnjmqe52zwf';

const snapshotRow = db.prepare('SELECT snapshot_data FROM document_snapshots WHERE document_id = ?').get(docId);
const updates = db.prepare('SELECT update_data FROM document_updates WHERE document_id = ?').all(docId);

const ydoc = new Y.Doc();

if (snapshotRow) {
  Y.applyUpdate(ydoc, snapshotRow.snapshot_data);
}
for (const update of updates) {
  Y.applyUpdate(ydoc, update.update_data);
}

console.log('Document Text Content:');
console.log('====================');
console.log(ydoc.getText('codemirror').toString());
console.log('====================');
db.close();
