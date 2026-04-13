
basedir='..'

test -w ${basedir}/.
if [ $? -ne 0 ]; then
    echo "Info: no write permissions for ${basedir}/"
    echo "Info: creating zip in current directory instead"
    basedir='.'
fi
zip=$basedir/django_map.zip
rm $zip

# populate /static folder to be served by nginx
####### we do this on elastic beanstalk, no need here! #######
#echo yes|python3 manage.py collectstatic --clear

# delete __pycache__ compiled bytecode files
find . -name "__pycache__" -type d | xargs rm -rf

# package for elastic beanstalk
zip -r $zip * .ebextensions .platform -x "media/*"

# show created zip
ls -l $zip
