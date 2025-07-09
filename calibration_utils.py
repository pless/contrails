from pyproj import Transformer
import numpy as np
import cv2
import pymap3d as pm


def ecef_to_enu_vasha(origin_ecef, points_ecef, cam_lat, cam_lon):

    lat0 = np.radians(cam_lat)
    lon0 = np.radians(cam_lon)

    # Rotation matrix from ECEF to ENU
    R = np.array([
        [-np.sin(lon0),              np.cos(lon0),             0],
        [-np.sin(lat0)*np.cos(lon0), -np.sin(lat0)*np.sin(lon0), np.cos(lat0)],
        [np.cos(lat0)*np.cos(lon0),  np.cos(lat0)*np.sin(lon0), np.sin(lat0)]
    ])

    # Subtract camera position (origin)
    delta = points_ecef - origin_ecef[None, :]
    # print('delta:',delta.shape, delta)
    # print('R',R.shape, R)
    return (R @ delta.T).T  # Shape (N, 3)


def gps_to_camxy_vasha_fixed(lats, lons, alts, cam_ecef, cam_k, cam_r, cam_t, camera_gps, distortion=None):
    """
    Fixed version of GPS to camera coordinates conversion.
    Properly handles objects behind camera and outside frame.
    """
    # Convert GPS to ECEF
    transformer_geodetic_to_ecef = Transformer.from_crs(
        "epsg:4979", "epsg:4978", always_xy=True)
    eX, eY, eZ = transformer_geodetic_to_ecef.transform(lons, lats, alts)
    ecef_points = np.column_stack((eX, eY, eZ))

    # Convert ECEF to ENU relative to camera
    enu_points = ecef_to_enu_vasha(
        cam_ecef, ecef_points, camera_gps[0], camera_gps[1])

    # CRITICAL FIX 1: Transform to camera coordinate system properly
    # Camera coordinates: X=right, Y=down, Z=forward (into scene)
    points_cam = (cam_r @ enu_points.T + cam_t).T  # Shape: (N, 3)

    # CRITICAL FIX 2: Filter out points behind camera BEFORE projection
    # Points with negative Z are behind the camera
    behind_camera_mask = points_cam[:, 2] <= 0

    # Initialize output arrays
    num_points = len(lats)
    image_x = np.full(num_points, np.nan)
    image_y = np.full(num_points, np.nan)
    cam_distance = points_cam[:, 2]  # Z coordinate is the distance

    # Only project points in front of camera
    if np.any(~behind_camera_mask):
        valid_points = enu_points[~behind_camera_mask]

        # Project using OpenCV
        rvec, _ = cv2.Rodrigues(cam_r)
        tvec = cam_t.astype(np.float32)

        if distortion is None:
            distortion = np.zeros((5, 1), dtype=np.float32)

        image_points, _ = cv2.projectPoints(
            valid_points.astype(np.float32),
            rvec, tvec, cam_k, distortion
        )
        image_points = image_points.reshape(-1, 2)

        # Assign projected coordinates back to output arrays
        valid_indices = np.where(~behind_camera_mask)[0]
        image_x[valid_indices] = image_points[:, 0]
        image_y[valid_indices] = image_points[:, 1]

    return image_x, image_y, cam_distance


def estimate_camera_params(origin_gps, poi_gps, poi_xy, frame_size, intrinsics_estimate=None, distortion_estimate=None):
    # Convert camera GPS coordinates to ECEF
    transformer_geodetic_to_ecef = Transformer.from_crs(
        "epsg:4979", "epsg:4978", always_xy=True)
    # Note: pyproj expects lon,lat,alt order
    eX, eY, eZ = transformer_geodetic_to_ecef.transform(
        origin_gps[1], origin_gps[0], origin_gps[2])
    cam_ecef = np.array([eX, eY, eZ]).T  # /1000  # Shape: (3,)
    eX, eY, eZ = transformer_geodetic_to_ecef.transform(
        poi_gps[:, 1], poi_gps[:, 0], poi_gps[:, 2])
    poi_ecef = np.vstack((eX, eY, eZ)).T  # /1000  # Shape: (3, N)
    poi_enu = ecef_to_enu_vasha(
        cam_ecef, poi_ecef, origin_gps[0], origin_gps[1])  # Shape: (N,3)

    # Put everything in contiguous arrays with (N, 3), not (3, N)
    object_points = np.ascontiguousarray(poi_enu.astype(np.float32))  # (N, 3)
    image_points = np.ascontiguousarray(
        poi_xy.astype(np.float32))      # (N, 2)

    if intrinsics_estimate is None:
        estimated_focal_dist = 1e5
        intrinsics_estimate = np.array([[estimated_focal_dist, 0, frame_size[1] / 2],
                                        [0, estimated_focal_dist,
                                            frame_size[0] / 2],
                                        [0, 0, 1]], dtype=np.float32)  # (3, 3)
    if distortion_estimate is None:
        # Use a zero distortion model if not provided
        distortion_estimate = np.zeros((5, 1), dtype=np.float32)

    criteria = (
        cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER,
        10000,    # Maximum 10,000 iterations (vs default ~30)
        1e-12     # Extremely tight convergence (vs default 1e-6)
    )

    calibrate_flags = (
        cv2.CALIB_USE_INTRINSIC_GUESS |         # Use your good initial guess
        # cv2.CALIB_USE_LU |         # Use your good initial guess
        cv2.CALIB_FIX_PRINCIPAL_POINT |        # Keep principal point fixed
        # cv2.CALIB_FIX_FOCAL_LENGTH |           # Keep focal lengths fixed
        # cv2.CALIB_FIX_ASPECT_RATIO |            # Keep fx/fy ratio fixed
        # cv2.CALIB_FIX_K1 | cv2.CALIB_FIX_K2 | cv2.CALIB_FIX_K3
        # CALIB_FIX_P1 | CALIB_FIX_P2 |  #fix tangential distortion
        # fix higher order radial distortions
        cv2.CALIB_FIX_K4 | cv2.CALIB_FIX_K5 | cv2.CALIB_FIX_K6 |
        cv2.CALIB_ZERO_TANGENT_DIST           # Only estimate radial distortion
    )
    # Let OpenCV estimate all distortion parameters
    ret, camera_matrix, dist_coeffs, rvecs, tvecs = cv2.calibrateCamera(
        [object_points], [image_points], frame_size,
        intrinsics_estimate,
        distortion_estimate,
        flags=calibrate_flags,
        criteria=criteria
    )

    T = tvecs[0]  # .reshape(3, 1)  # Reshape to (3, 1)
    R, _ = cv2.Rodrigues(rvecs[0])

    return camera_matrix, dist_coeffs, R, T, cam_ecef


def calculate_fov_from_intrinsics(intrinsics, image_width, image_height, distortion=None):
    """
    Calculate horizontal and vertical field of view from camera intrinsics matrix.

    *** NOTE: This method assumes no distortion is applied.
    Without distortion -  ***

    Args:
        intrinsics: 3x3 camera intrinsics matrix (K matrix)
        image_width: Width of the image in pixels
        image_height: Height of the image in pixels
        distortion: Optional distortion coefficients (not used in this calculation)

    Returns:
        hfov: Horizontal field of view in radians
        vfov: Vertical field of view in radians
        hfov_deg: Horizontal field of view in degrees
        vfov_deg: Vertical field of view in degrees
    """
    # Extract focal lengths and principal point
    fx = intrinsics[0, 0]  # focal length in x (pixels)
    fy = intrinsics[1, 1]  # focal length in y (pixels)
    cx = intrinsics[0, 2]  # principal point x
    cy = intrinsics[1, 2]  # principal point y

    # Left and right angles from principal point
    angle_left = np.arctan(cx / fx)
    angle_right = np.arctan((image_width - cx) / fx)
    hfov = angle_left + angle_right

    # Top and bottom angles from principal point
    angle_top = np.arctan(cy / fy)
    angle_bottom = np.arctan((image_height - cy) / fy)
    vfov = angle_top + angle_bottom

    # Method 2: Simplified calculation (assumes centered principal point)
    # hfov_simple = 2 * np.arctan(image_width / (2 * fx))
    # vfov_simple = 2 * np.arctan(image_height / (2 * fy))

    # Convert to degrees for display
    hfov_deg = np.degrees(hfov)
    vfov_deg = np.degrees(vfov)

    # return hfov, vfov, hfov_deg, vfov_deg
    return (hfov_deg.item(), vfov_deg.item())


def calculate_camera_angles(cam_r):
    """
    Calculate camera orientation angles from rotation matrix.

    Returns:
        azimuth: Camera azimuth in degrees (0=North, 90=East, 180=South, 270=West)
        elevation: Camera elevation/pitch in degrees (positive=up, negative=down)
        roll: Camera roll in degrees (rotation around forward axis)
    """
    # Camera directions
    # right = cam_r[:, 0]    # Camera right direction in ENU (for Roll)
    # down = cam_r[:, 1]     # Camera down direction in ENU (for Roll)
    # The rotation matrix transforms from ENU to camera coordinates
    # To get camera orientation in ENU, we need the inverse (transpose for orthogonal matrix)
    R_camera_to_enu = cam_r.T

    # Camera forward direction in ENU coordinates
    # In camera space, forward is [0, 0, 1], so in ENU it's the 3rd column of R^T
    forward_enu = R_camera_to_enu[:, 2]

    # Camera up direction in ENU coordinates
    # In camera space, up is [0, -1, 0] (negative Y), so in ENU it's negative 2nd column of R^T
    # up_enu = -R_camera_to_enu[:, 1]

    # Azimuth: angle in horizontal plane (from North)
    # In ENU: North is +Y, East is +X
    azimuth = np.degrees(np.arctan2(forward_enu[0], forward_enu[1]))
    if azimuth < 0:
        azimuth += 360

    # Elevation: angle from horizontal plane
    horizontal_distance = np.sqrt(forward_enu[0]**2 + forward_enu[1]**2)
    elevation = np.degrees(np.arctan2(forward_enu[2], horizontal_distance))

    # TODO: Calculate Roll (untested Claude code commented out below)
    # Expected right direction (perpendicular to forward in horizontal plane)
    # expected_right = np.array([
    #     np.sin(np.radians(azimuth + 90)),
    #     np.cos(np.radians(azimuth + 90)),
    #     0
    # ])
    # # Camera up vector (negative of down)
    # up = -down
    # # Calculate roll by checking how much the up vector deviates from vertical
    # # when projected onto the plane perpendicular to forward
    # world_up = np.array([0, 0, 1])
    # # Remove forward component from world_up
    # world_up_perp = world_up - np.dot(world_up, forward) * forward
    # world_up_perp = world_up_perp / np.linalg.norm(world_up_perp)
    # # Remove forward component from camera up
    # cam_up_perp = up - np.dot(up, forward) * forward
    # cam_up_perp = cam_up_perp / np.linalg.norm(cam_up_perp)
    # # Calculate angle between them
    # cos_roll = np.dot(world_up_perp, cam_up_perp)
    # cos_roll = np.clip(cos_roll, -1, 1)
    # # Determine sign of roll using cross product
    # cross = np.cross(world_up_perp, cam_up_perp)
    # sign = np.sign(np.dot(cross, forward))
    # roll = sign * np.degrees(np.arccos(cos_roll))

    return (azimuth.item(), elevation.item())


def getCameraPosition(refPoint, K, R, t):
    """
    Get camera position in ENU coordinates.
    refPoint: Reference point in GPS coordinates not same as Cam (lat, lon, alt)
    K: Camera intrinsic matrix
    R: Camera rotation matrix
    t: Camera translation vector
    """
    # Convert reference point to ENU coordinates

    # Camera position in ENU is the negative translation vector
    cam_pos_enu = -t.flatten()  # Ensure it's a 1D array

    # Rotate camera position back to world coordinates
    cam_pos_world = R.T @ cam_pos_enu
    print('Camera Position in ENU:', cam_pos_enu)
    # Convert back to GPS coordinates
    cam_gps = pm.enu2geodetic(
        cam_pos_world[0], cam_pos_world[1], cam_pos_world[2], refPoint[0], refPoint[1], refPoint[2])

    return cam_gps, cam_pos_world


def calculate_fov_from_intrinsics(intrinsics, image_width, image_height, distortion=None):
    """
    Calculate horizontal and vertical field of view from camera intrinsics matrix.

    *** NOTE: This method assumes no distortion is applied.
    Without distortion -  ***

    Args:
        intrinsics: 3x3 camera intrinsics matrix (K matrix)
        image_width: Width of the image in pixels
        image_height: Height of the image in pixels
        distortion: Optional distortion coefficients (not used in this calculation)

    Returns:
        hfov: Horizontal field of view in radians
        vfov: Vertical field of view in radians
        hfov_deg: Horizontal field of view in degrees
        vfov_deg: Vertical field of view in degrees
    """
    # Extract focal lengths and principal point
    fx = intrinsics[0, 0]  # focal length in x (pixels)
    fy = intrinsics[1, 1]  # focal length in y (pixels)
    cx = intrinsics[0, 2]  # principal point x
    cy = intrinsics[1, 2]  # principal point y

    # Left and right angles from principal point
    angle_left = np.arctan(cx / fx)
    angle_right = np.arctan((image_width - cx) / fx)
    hfov = angle_left + angle_right

    # Top and bottom angles from principal point
    angle_top = np.arctan(cy / fy)
    angle_bottom = np.arctan((image_height - cy) / fy)
    vfov = angle_top + angle_bottom

    # Method 2: Simplified calculation (assumes centered principal point)
    # hfov_simple = 2 * np.arctan(image_width / (2 * fx))
    # vfov_simple = 2 * np.arctan(image_height / (2 * fy))

    # Convert to degrees for display
    hfov_deg = np.degrees(hfov)
    vfov_deg = np.degrees(vfov)

    # return hfov, vfov, hfov_deg, vfov_deg
    return (hfov_deg.item(), vfov_deg.item())
