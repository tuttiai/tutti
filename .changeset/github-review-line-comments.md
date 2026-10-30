---
"@tuttiai/github": minor
---

`create_review` takes optional `comments` on lines of the diff, so a review's findings sit on the code they are about. A comment on a line the pull request did not change is moved into the review's body instead of making GitHub refuse the whole review.
