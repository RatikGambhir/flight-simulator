# Lunar surface

`moon-color.jpg` is NASA Scientific Visualization Studio's 2K LRO/LROC lunar
color map, centered on 0° longitude. Credit: NASA's Scientific Visualization
Studio, Ernie Wright; Lunar Reconnaissance Orbiter / Lunar Reconnaissance
Orbiter Camera teams.

Source and usage information: https://svs.gsfc.nasa.gov/4720/
Original asset: https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_2k.jpg

The renderer treats the image as sRGB and uses Moon-fixed coordinates from
Astronomy Engine to account for lunar rotation and libration. Orbital position,
phase, distance-dependent angular size and observer parallax use the actual
calendar date, time and aircraft ECEF location. Manual time changes the solar
hour on today's local solar date. Stars use the bundled Yale Bright Star Catalog
with the same inertial-to-Earth-to-local-frame transformation.

# City lights

`city-lights.jpg` is an 8192 × 4096 resample of the 2016 global grayscale
Black Marble image from NASA Earth Observatory. The map uses equirectangular
coordinates with north at the top and −180° longitude at the left edge.
It provides the measured light distribution. The renderer synthesizes finer
light points below the satellite resolution.

Source: https://science.nasa.gov/earth/earth-observatory/earth-at-night/maps/

Original asset: https://assets.science.nasa.gov/content/dam/science/esd/eo/images/imagerecords/144000/144897/BlackMarble_2016_3km_gray.jpg
