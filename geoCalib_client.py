from gradio_client import Client, handle_file
import re

client = Client("veichta/GeoCalib")


def get_camera_parameters_estimate(image_url, camera_model="pinhole", plot_up=False, plot_up_confidence=False,
                                   plot_latitude=False, plot_latitude_confidence=False, plot_undistort=True):
    result = client.predict(
        image_path=handle_file(image_url),
        camera_model=camera_model,
        plot_up=plot_up,
        plot_up_confidence=plot_up_confidence,
        plot_latitude=plot_latitude,
        plot_latitude_confidence=plot_latitude_confidence,
        plot_undistort=plot_undistort,
        api_name="/process_results"
    )
    # results has 2 things
    # [0] str

    # The output value that appears in the "Estimated parameters" Textbox component.

    # [1] filepath

    # The output value that appears in the "Calibration Results" Image component.
    # result is text of the form:
    # "Estimated parameters:
    # Roll:  -2.02° (± 1.82)°
    # Pitch: 8.74° (± 2.25)°
    # vFoV:  52.40° (± 7.99)°
    # Focal: 1975.26 px (± 245.85 px)"
    # K1: -0.00

    # parse the text to get the parameters
    lines = result[0].split("\n")
    params = {}
    for line in lines[1:]:
        if line.strip():
            key, value = line.split(":")
            params[key.strip()] = value.strip()
            # value has 2 things - the value and the uncertainty in parentheses
            # write regex to extract numbers
            # there will to 2 numbers in value
            numbers = re.findall(r"[-+]?\d*\.\d+|\d+", value)
            if len(numbers) == 2:
                params[key.strip()] = (float(numbers[0]), float(numbers[1]))
            elif len(numbers) == 1:
                params[key.strip()] = (float(numbers[0]), 0.0)
    return params, result[1], result[0]


if __name__ == "__main__":
    # test the function
    image_url = "https://metobs.ssec.wisc.edu/pub/cache/aoss/cameras/northwest/latest_orig.jpg"
    params, result_image_path, result_text = get_camera_parameters_estimate(
        image_url)
    print("Estimated parameters:")
    for key, value in params.items():
        print(f"{key}: {value}")
    print(f"Result image saved at: {result_image_path}")
