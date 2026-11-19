@echo off
cd /d "c:\Users\Nuelthewave\Desktop\Veridatum Pr\earnproof-backend"

echo Pushing merge/consolidated-features-20261015 to remote...
git push -u origin merge/consolidated-features-20261015

if errorlevel 1 (
    echo Push failed, retrying...
    timeout /t 3 /nobreak
    git push -u origin merge/consolidated-features-20261015
)

if errorlevel 1 (
    echo Push failed again
    exit /b 1
) else (
    echo Push successful!
)

echo.
echo Creating a commit to document the merge
git log --oneline -1

pause
