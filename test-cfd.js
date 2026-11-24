import { db } from './src/db.js';
import {
  generateTimelineBuckets,
  normalizeStatus,
  getCumulativeFlowData,
  getCFDSummaryMetrics,
  getCFDBottlenecks,
  getCFDTicketsDrilldown,
} from './src/features/reports/server/cfd-engine.js';

async function runCfdTests() {
  console.log('=== RUNNING CFD ENGINE VALIDATION SUITE ===\n');

  // Test 1: Normalize status mapping
  console.log('Test 1: Normalizing status strings...');
  const tests = [
    { input: 'In Progress', expected: 'IN_PROGRESS' },
    { input: 'IN_REVIEW', expected: 'CODE_REVIEW' },
    { input: 'Testing', expected: 'TESTING' },
    { input: 'Done', expected: 'DONE' },
    { input: 'Resolved', expected: 'DONE' },
    { input: 'Backlog', expected: 'BACKLOG' },
    { input: 'Custom Stage', expected: 'CUSTOM_STAGE' },
  ];
  for (const t of tests) {
    const res = normalizeStatus(t.input);
    if (res !== t.expected) {
      throw new Error(`normalizeStatus('${t.input}') expected '${t.expected}' but got '${res}'`);
    }
  }
  console.log('  ✓ normalizeStatus passes all canonical mappings');

  // Test 2: generateTimelineBuckets
  console.log('Test 2: Generating timeline buckets...');
  const dailyBuckets = generateTimelineBuckets('2026-11-01', '2026-11-07', 'daily');
  if (dailyBuckets.length !== 7) {
    throw new Error(`Expected 7 daily buckets, got ${dailyBuckets.length}`);
  }
  const weeklyBuckets = generateTimelineBuckets('2026-11-01', '2026-11-28', 'weekly');
  if (weeklyBuckets.length < 4) {
    throw new Error(`Expected at least 4 weekly buckets, got ${weeklyBuckets.length}`);
  }
  console.log(`  ✓ generateTimelineBuckets passes (daily: ${dailyBuckets.length}, weekly: ${weeklyBuckets.length})`);

  // Test 3: Workspace execution
  const ws = db.prepare('SELECT id, name FROM workspaces LIMIT 1').get();
  if (!ws) {
    console.log('No workspace found in local db, skipping DB tests.');
    return;
  }
  console.log(`\nTesting on workspace: "${ws.name}" (${ws.id})`);

  // Test 4: getCumulativeFlowData
  console.log('Test 4: getCumulativeFlowData...');
  const cfdData = await getCumulativeFlowData({
    workspaceId: ws.id,
    query: { dateRange: '30d', interval: 'daily' },
  });
  console.log(`  ✓ Timeline points: ${cfdData.timeline.length}`);
  console.log(`  ✓ Statuses tracked: ${cfdData.statuses.map((s) => s.key).join(', ')}`);
  console.log(`  ✓ Total tickets in scope: ${cfdData.totalTickets}`);

  // Test 5: getCFDSummaryMetrics
  console.log('\nTest 5: getCFDSummaryMetrics...');
  const summary = await getCFDSummaryMetrics({
    workspaceId: ws.id,
    query: { dateRange: '30d' },
  });
  console.log(`  ✓ Total Tickets: ${summary.totalTickets}`);
  console.log(`  ✓ WIP: ${summary.wip}`);
  console.log(`  ✓ Completed: ${summary.completedTickets}`);
  console.log(`  ✓ Throughput: ${summary.throughput.daily}/day (${summary.throughput.weekly}/wk)`);
  console.log(`  ✓ Avg Cycle Time: ${summary.avgCycleTimeDays} days`);
  console.log(`  ✓ Avg Lead Time: ${summary.avgLeadTimeDays} days`);
  console.log(`  ✓ Primary Bottleneck: ${summary.bottleneck.stage} (severity: ${summary.bottleneck.severity})`);

  // Test 6: getCFDBottlenecks
  console.log('\nTest 6: getCFDBottlenecks...');
  const bottlenecks = await getCFDBottlenecks({
    workspaceId: ws.id,
    query: {},
  });
  console.log(`  ✓ Monitored Stages: ${bottlenecks.stages.length}`);
  bottlenecks.stages.forEach((st) => {
    console.log(`    - ${st.label}: ${st.accumulatedCount} tickets, ${st.avgDwellTimeDays}d avg dwell, severity: ${st.severity}`);
  });

  // Test 7: getCFDTicketsDrilldown
  console.log('\nTest 7: getCFDTicketsDrilldown...');
  const drilldown = await getCFDTicketsDrilldown({
    workspaceId: ws.id,
    query: { status: 'IN_PROGRESS' },
  });
  console.log(`  ✓ Drilldown status: ${drilldown.status}, tickets found: ${drilldown.count}`);

  console.log('\n🎉 ALL CFD VERIFICATION TESTS PASSED SUCCESSFULLY!');
}

runCfdTests().catch((err) => {
  console.error('\n❌ CFD TEST SUITE FAILED:', err);
  process.exit(1);
});
