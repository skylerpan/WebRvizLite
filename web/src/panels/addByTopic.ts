/**
 * "By topic" grouping for the Add Display dialog (rviz_common TopicDisplayWidget):
 * one entry per topic × message type that at least one registered Display accepts.
 * A topic with a single matching display is selectable as a row by itself; one
 * with several (e.g. sensor_msgs/msg/Image → Image / Camera) lists them beneath it.
 */

import type { DisplayClassInfo } from '../displays/types';
import type { TopicInfo } from '../worker/messages';

export interface TopicEntry {
  topic: string;
  type: string;
  displays: DisplayClassInfo[];
}

export function groupTopicsByDisplay(topics: readonly TopicInfo[], displays: readonly DisplayClassInfo[]): TopicEntry[] {
  const out: TopicEntry[] = [];
  for (const t of topics) {
    for (const type of t.types) {
      const matching = displays.filter((d) => d.messageTypes.includes(type));
      if (matching.length) out.push({ topic: t.name, type, displays: matching });
    }
  }
  return out.sort((a, b) => a.topic.localeCompare(b.topic));
}
