---
"@tuttiai/github": patch
---

`get_pull_request` lists a pull request's reviews instead of miscounting them.

It printed `Reviews: <n>` from GitHub's `review_comments` field, which counts inline review comments, so a review with only a body (an approval, a request for changes or a comment with a verdict) counted as none. A QA agent read "Reviews: 0" after a review had been posted and stopped the run to ask the owner to check. It now lists every review with its state, author, the commit it was given on and when it was submitted (or that it is still pending), labels the old figure "Inline review comments", and adds the head commit SHA. A review list it cannot read is said so beside the pull request rather than failing the call.
