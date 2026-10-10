import { describe, expect, it } from 'vitest';
import { groupTopicsByDisplay } from './addByTopic';
import type { DisplayClassInfo } from '../displays/types';

const info = (classId: string, name: string, ...messageTypes: string[]): DisplayClassInfo => ({ classId, name, description: '', messageTypes });

const DISPLAYS: DisplayClassInfo[] = [
  info('rviz_default_plugins/Grid', 'Grid'),
  info('rviz_default_plugins/LaserScan', 'LaserScan', 'sensor_msgs/msg/LaserScan'),
  info('rviz_default_plugins/Image', 'Image', 'sensor_msgs/msg/Image'),
  info('rviz_default_plugins/Camera', 'Camera', 'sensor_msgs/msg/Image'),
  info('rviz_default_plugins/Odometry', 'Odometry', 'nav_msgs/msg/Odometry'),
];

describe('groupTopicsByDisplay', () => {
  it('drops topics whose types no display accepts', () => {
    const out = groupTopicsByDisplay([{ name: '/rosout', types: ['rcl_interfaces/msg/Log'] }], DISPLAYS);
    expect(out).toEqual([]);
  });

  it('makes one entry per topic and type', () => {
    const out = groupTopicsByDisplay([{ name: '/multi', types: ['sensor_msgs/msg/LaserScan', 'nav_msgs/msg/Odometry', 'std_msgs/msg/Empty'] }], DISPLAYS);
    expect(out.map((e) => e.type)).toEqual(['sensor_msgs/msg/LaserScan', 'nav_msgs/msg/Odometry']);
    expect(out.map((e) => e.displays.map((d) => d.name))).toEqual([['LaserScan'], ['Odometry']]);
  });

  it('lists every display that accepts the type', () => {
    const out = groupTopicsByDisplay([{ name: '/camera/image_raw', types: ['sensor_msgs/msg/Image'] }], DISPLAYS);
    expect(out).toHaveLength(1);
    expect(out[0].displays.map((d) => d.name)).toEqual(['Image', 'Camera']);
  });

  it('sorts entries by topic name', () => {
    const out = groupTopicsByDisplay(
      [
        { name: '/scan', types: ['sensor_msgs/msg/LaserScan'] },
        { name: '/camera/image_raw', types: ['sensor_msgs/msg/Image'] },
        { name: '/odom', types: ['nav_msgs/msg/Odometry'] },
      ],
      DISPLAYS,
    );
    expect(out.map((e) => e.topic)).toEqual(['/camera/image_raw', '/odom', '/scan']);
  });
});
