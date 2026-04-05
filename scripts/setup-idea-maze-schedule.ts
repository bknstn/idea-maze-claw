import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from '../src/config.js';
import {
  createTask,
  getAllRegisteredGroups,
  getTaskById,
  initDatabase,
  updateTask,
} from '../src/db.js';
import { ScheduledTask } from '../src/types.js';

interface TaskDefinition {
  id: string;
  prompt: string;
  schedule_type: ScheduledTask['schedule_type'];
  schedule_value: string;
  context_mode: ScheduledTask['context_mode'];
  script?: string;
}

const TASK_DEFINITIONS: TaskDefinition[] = [
  {
    id: 'idea-maze-pipeline',
    prompt:
      'Run the active Idea Maze pipeline. Execute: cd /workspace/group/scripts && tsx run-pipeline.ts. Report a concise results summary.',
    schedule_type: 'interval',
    schedule_value: '3600000',
    context_mode: 'isolated',
  },
  {
    id: 'idea-maze-weekly-digest',
    prompt:
      'Generate the weekly Idea Maze digest. Query the top 10 opportunities from lab.db ordered by score. Include title, score, insight count, and top signals. Format as a concise report.',
    schedule_type: 'cron',
    schedule_value: '0 8 * * 1',
    context_mode: 'isolated',
  },
  {
    id: 'idea-maze-raw-cleanup',
    prompt:
      'Run raw file cleanup. Execute: cd /workspace/group/scripts && tsx cleanup-raw.ts --days 30. Report how many files were removed.',
    schedule_type: 'cron',
    schedule_value: '0 3 * * *',
    context_mode: 'isolated',
    script: [
      'cd /workspace/group/scripts',
      'COUNT=$(find /workspace/group/data/raw -name "*.json" -mtime +30 2>/dev/null | wc -l)',
      'if [ "$COUNT" -eq 0 ]; then',
      `  echo '{"wakeAgent": false}'`,
      'else',
      `  echo '{"wakeAgent": true, "data": {"stale_files": '$COUNT'}}'`,
      'fi',
    ].join('\n'),
  },
];

function computeInitialNextRun(
  scheduleType: ScheduledTask['schedule_type'],
  scheduleValue: string,
): string | null {
  if (scheduleType === 'cron') {
    const interval = CronExpressionParser.parse(scheduleValue, { tz: TIMEZONE });
    return interval.next().toISOString();
  }

  if (scheduleType === 'interval') {
    const ms = Number.parseInt(scheduleValue, 10);
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new Error(`Invalid interval: ${scheduleValue}`);
    }
    return new Date(Date.now() + ms).toISOString();
  }

  const date = new Date(scheduleValue);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid timestamp: ${scheduleValue}`);
  }
  return date.toISOString();
}

function main(): void {
  initDatabase();

  const ideaMazeEntry = Object.entries(getAllRegisteredGroups()).find(
    ([, group]) => group.folder === 'idea-maze',
  );

  if (!ideaMazeEntry) {
    throw new Error(
      'Registered group for folder "idea-maze" not found. Register the Idea Maze chat first.',
    );
  }

  const [chatJid] = ideaMazeEntry;

  for (const task of TASK_DEFINITIONS) {
    const nextRun = computeInitialNextRun(task.schedule_type, task.schedule_value);
    const existing = getTaskById(task.id);

    if (existing) {
      updateTask(task.id, {
        prompt: task.prompt,
        script: task.script || null,
        schedule_type: task.schedule_type,
        schedule_value: task.schedule_value,
        next_run: nextRun,
        status: 'active',
      });
      console.log(`Updated ${task.id} → ${nextRun}`);
      continue;
    }

    createTask({
      id: task.id,
      group_folder: 'idea-maze',
      chat_jid: chatJid,
      prompt: task.prompt,
      script: task.script || null,
      schedule_type: task.schedule_type,
      schedule_value: task.schedule_value,
      context_mode: task.context_mode,
      next_run: nextRun,
      status: 'active',
      created_at: new Date().toISOString(),
    });
    console.log(`Created ${task.id} → ${nextRun}`);
  }
}

main();
