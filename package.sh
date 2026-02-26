zip=../django_map.zip
# delete __pycache__ compiled bytecode files
find . -name "__pycache__" -type d | xargs rm -rf {}\;

# package for elastic beanstalk
zip -r $zip * .ebextensions .platform

# show created zip
ls -l $zip
