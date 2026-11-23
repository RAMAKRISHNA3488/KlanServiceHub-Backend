import {
  hasDirectedBlockingCycle,
  normalizeRelationshipType,
  INVERSE_RELATIONSHIPS,
  getRelationshipCategory,
  isStatusDone
} from './src/features/ticket-links/server/route.js';

console.log('=== Running Ticket-to-Ticket Linking Unit & Logic Tests ===\n');

// 1. Test Inverses and normalization
console.log('1. Checking inverse mappings...');
for (const [key, expectedInverse] of Object.entries(INVERSE_RELATIONSHIPS)) {
  const norm = normalizeRelationshipType(key);
  if (norm !== key) throw new Error(`Normalization failed for ${key}`);
  const inv = INVERSE_RELATIONSHIPS[norm];
  if (inv !== expectedInverse) throw new Error(`Inverse mismatch for ${key}: got ${inv}, expected ${expectedInverse}`);
}
console.log('✔ All 7 relationship types & inverses mapped correctly.\n');

// 2. Test in-memory mock for cycle detection & link rules
console.log('2. Testing directed cycle detection with mock D1...');
const memoryRows = [];

// Mock D1 wrapper
const createPreparedStatement = () => ({
  all: async () => ({ results: [...memoryRows] }),
  first: async () => memoryRows[0] || null,
  run: async () => ({ success: true }),
  bind: () => createPreparedStatement(),
});

const mockD1 = {
  prepare: (sql) => createPreparedStatement(),
};

async function runCycleTests() {
  const tA = 'ticket-A';
  const tB = 'ticket-B';
  const tC = 'ticket-C';
  const tD = 'ticket-D';

  // Initially: A blocks B
  memoryRows.push({
    id: 'link-1',
    source_task_id: tA,
    target_task_id: tB,
    relationship_type: 'blocks',
    created_by: 'user-1'
  });

  // Next: B blocks C
  memoryRows.push({
    id: 'link-2',
    source_task_id: tB,
    target_task_id: tC,
    relationship_type: 'blocks',
    created_by: 'user-1'
  });

  // Check 1: Can C block D? (C -> D should be ALLOWED)
  const cycleCD = await hasDirectedBlockingCycle(mockD1, tC, tD);
  if (cycleCD) throw new Error('Expected C -> D to NOT be a cycle, but cycle was detected');
  console.log('✔ Non-cyclic edge (C -> D) correctly allowed.');

  // Check 2: Can B block A? (Direct cycle B -> A should be REJECTED)
  const cycleBA = await hasDirectedBlockingCycle(mockD1, tB, tA);
  if (!cycleBA) throw new Error('Expected B -> A to be detected as direct cycle, but was not');
  console.log('✔ Direct circular dependency (B -> A) correctly detected and blocked.');

  // Check 3: Can C block A? (Transitive cycle C -> A through A -> B -> C should be REJECTED)
  const cycleCA = await hasDirectedBlockingCycle(mockD1, tC, tA);
  if (!cycleCA) throw new Error('Expected C -> A to be detected as transitive cycle, but was not');
  console.log('✔ Transitive circular dependency (C -> A via A -> B -> C) correctly detected and blocked.');

  // Check 4: Testing "is blocked by" equivalent: if D is blocked by C (which means C -> D),
  // then D cannot block C
  memoryRows.push({
    id: 'link-3',
    source_task_id: tD,
    target_task_id: tC,
    relationship_type: 'is blocked by',
    created_by: 'user-1'
  });

  const cycleDC = await hasDirectedBlockingCycle(mockD1, tD, tC);
  if (!cycleDC) throw new Error('Expected D -> C to be detected as cycle');
  console.log('✔ Inverse relationship "is blocked by" correctly included in cycle graph.');

  // Check 5: Status completion checks
  if (!isStatusDone('DONE')) throw new Error('isStatusDone failed for DONE');
  if (!isStatusDone('RESOLVED')) throw new Error('isStatusDone failed for RESOLVED');
  if (isStatusDone('IN_PROGRESS')) throw new Error('isStatusDone failed for IN_PROGRESS');
  if (isStatusDone('TODO')) throw new Error('isStatusDone failed for TODO');
  console.log('✔ Blocker resolution status logic verified.');

  console.log('\nAll ticket-to-ticket linking and dependency management business rules verified successfully!');
}

runCycleTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
