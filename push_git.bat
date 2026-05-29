@echo off
echo =========================================
echo 🚀 Automated Git Push Script (Backend)
echo =========================================
echo Adding files to git staging...
git add .

echo.
echo Committing files...
git commit -m "initial commit"

echo.
echo Pushing to remote repository...
git push -u origin main

echo.
echo =========================================
echo ✅ Git Push Completed!
echo =========================================
pause
