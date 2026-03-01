FROM mcr.microsoft.com/devcontainers/python:3.14

# Install GDAL and PostGIS dependencies
RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
    && apt-get -y install --no-install-recommends \
    gdal-bin \
    python3-gdal \
    postgis

# Install python requirements if they exist
COPY requirements.txt /tmp/pip-tmp/
RUN pip3 --disable-pip-version-check --no-cache-dir install -r /tmp/pip-tmp/requirements.txt \
   && rm -rf /tmp/pip-tmp