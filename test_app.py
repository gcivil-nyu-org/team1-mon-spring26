# test_app.py
import sys

def test_python_version():
    # Simple check to ensure we are running on Python 3
    assert sys.version_info.major == 3

def test_import():
    try:
        from maps.models import Amenity, AmenityType # Replace with your actual app/folder name
        assert True
    except ImportError:
        assert False, "The application models could not be imported"