from fastapi import FastAPI, HTTPException, Body
from pydantic import BaseModel, Field
from typing import List
import numpy as np
import cv2
from io import BytesIO
from PIL import Image
import requests
from fastapi.middleware.cors import CORSMiddleware

# Local imports
from geoCalib_client import get_camera_parameters_estimate
from calibration_utils import estimate_camera_params, gps_to_camxy_vasha_fixed

# --- Pydantic Models ---


class CalibrationRequest(BaseModel):
    imagePoints: List[List[float]] = Field(..., min_items=4)
    worldPoints: List[List[float]] = Field(..., min_items=4)
    imageUrl: str
    flags: int | None = None


class CalibrationResponse(BaseModel):
    k_matrix: List[List[float]]
    r_matrix: List[List[float]]
    t_vector: List[List[float]]
    estimated_image_points: List[List[float]]

# --- FastAPI App ---


app = FastAPI(
    title="Camera Calibration API",
    description="An API to calculate camera matrix and distortion coefficients using a combination of initial estimation and refinement.",
    version="1.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Or specify domains like ["http://localhost:3000"]
    allow_credentials=True,
    allow_methods=["*"],  # Make sure OPTIONS is included
    allow_headers=["*"],
)


@app.post("/calibrate", response_model=CalibrationResponse)
async def calibrate_camera(data: CalibrationRequest):
    """
    Calibrates a camera by first getting an initial estimate from geocalib,
    then refining it using local feature points.
    """
    try:
        # --- 1. Get Initial Estimate from GeoCalib ---
        try:
            initial_params, _, _ = get_camera_parameters_estimate(
                data.imageUrl)
            # Default to 50 deg if not found
            focal_length_deg = initial_params.get('vFoV', (50, 0))[0]
        except Exception as e:
            raise HTTPException(
                status_code=503, detail=f"GeoCalib service failed: {e}")

        # --- 2. Prepare for Refinement ---
        # Fetch image to get its size
        try:
            response = requests.get(data.imageUrl)
            response.raise_for_status()
            pil_img = Image.open(BytesIO(response.content))
            # (height, width) for utils
            frame_size = (pil_img.height, pil_img.width)
        except requests.RequestException as e:
            raise HTTPException(
                status_code=400, detail=f"Failed to fetch image from URL: {e}")

        focal_length = 0.5 * frame_size[0] / \
            np.tan(0.5 * np.radians(focal_length_deg))

        # Create initial K matrix (intrinsics)
        initial_k = np.array([
            [focal_length, 0, frame_size[1] / 2],
            [0, focal_length, frame_size[0] / 2],
            [0, 0, 1]
        ], dtype=np.float32)

        # --- 3. Refine with calibration_utils ---
        if len(data.imagePoints) != len(data.worldPoints):
            raise HTTPException(
                status_code=400, detail="Number of image and world points must match.")

        poi_xy = np.array(data.imagePoints[1:])
        poi_gps = np.array(data.worldPoints[1:])
        origin_gps = np.array(data.worldPoints[0])

        try:
            k_matrix, dist_coeffs, r_matrix, t_vector, cam_ecef_coords = estimate_camera_params(
                origin_gps,
                poi_gps,
                poi_xy,
                frame_size,
                intrinsics_estimate=initial_k,
                flags=data.flags
            )
        except Exception as e:
            raise HTTPException(
                status_code=500, detail=f"Calibration refinement failed: {e}")

        # --- 4. Calculate Reprojection Error ---
        # use gps_to_camxy_vasha_fixed
        image_x, image_y, cam_distance = gps_to_camxy_vasha_fixed(
            poi_gps[:, 0],  # lats
            poi_gps[:, 1],  # lons
            poi_gps[:, 2],  # alts
            cam_k=k_matrix,
            cam_r=r_matrix,
            cam_t=t_vector,
            cam_ecef=cam_ecef_coords,
            camera_gps=origin_gps,
            distortion=dist_coeffs
        )

        # # add input points to estimated points for response
        # image_x = np.insert(image_x, 0, data.imagePoints[0][0])
        # image_y = np.insert(image_y, 0, data.imagePoints[0][1])
        image_x = np.concatenate(([data.imagePoints[0][0]], image_x))
        image_y = np.concatenate(([data.imagePoints[0][1]], image_y))

        return {
            "k_matrix": k_matrix.tolist(),
            "r_matrix": r_matrix.tolist(),
            "t_vector": t_vector.tolist(),
            "estimated_image_points": np.vstack((image_x, image_y)).T.tolist(),
        }

    except HTTPException as e:
        raise e  # Re-raise HTTPException to keep status code and detail
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"An unexpected error occurred: {str(e)}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=5001)
