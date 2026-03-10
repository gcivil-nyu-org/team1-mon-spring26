zip=../django_map.zip
rm $zip

# populate /static folder to be served by nginx
####### we do this on elastic beanstalk, no need here! #######
#echo yes|python3 manage.py collectstatic --clear

# delete __pycache__ compiled bytecode files
find . -name "__pycache__" -type d | xargs rm -rf

# package for elastic beanstalk
zip -r $zip * .ebextensions .platform

# show created zip
ls -l $zip
