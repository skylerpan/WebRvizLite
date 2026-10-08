import { DisplayRegistryImpl } from './Display';
import { GRID_INFO, GridDisplay } from './grid';
import { AXES_INFO, AxesDisplay } from './axes';
import { TF_INFO, TfDisplay } from './tfDisplay';
import { MAP_INFO, MapDisplay } from './mapDisplay';
import { PATH_INFO, PathDisplay } from './pathDisplay';
import { POSE_INFO, PoseDisplay } from './poseDisplay';
import { POSE_ARRAY_INFO, PoseArrayDisplay } from './poseArrayDisplay';
import { POINT_CLOUD2_INFO, PointCloud2Display } from './pointCloud2Display';
import { LASER_SCAN_INFO, LaserScanDisplay } from './laserScanDisplay';
import { MARKER_ARRAY_INFO, MARKER_INFO, MarkerArrayDisplay, MarkerDisplay } from './markerDisplay';
import type { DisplayRegistry } from './types';

/** Builds the registry of built-in displays (spec §4.2: internal plugin-style registry). */
export function createDisplayRegistry(fixedFrame: () => string): DisplayRegistry {
  const r = new DisplayRegistryImpl();
  r.register(GRID_INFO, () => new GridDisplay(fixedFrame));
  r.register(AXES_INFO, () => new AxesDisplay(fixedFrame));
  r.register(TF_INFO, () => new TfDisplay());
  r.register(MAP_INFO, () => new MapDisplay());
  r.register(PATH_INFO, () => new PathDisplay());
  r.register(POSE_INFO, () => new PoseDisplay());
  r.register(POSE_ARRAY_INFO, () => new PoseArrayDisplay());
  r.register(POINT_CLOUD2_INFO, () => new PointCloud2Display());
  r.register(LASER_SCAN_INFO, () => new LaserScanDisplay());
  r.register(MARKER_INFO, () => new MarkerDisplay());
  r.register(MARKER_ARRAY_INFO, () => new MarkerArrayDisplay());
  return r;
}
