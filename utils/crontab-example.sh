MAILTO=xxx@xxx.de
PATH=$PATH:/usr/local/bin/
@reboot /usr/local/bin/forever -c /usr/local/bin/coffee ~/node/overheid/anon.coffee >> ~/node/log/overheid.log
0 */1 * * * /bin/cat ~/node/log/overheid.log | /usr/bin/mail -s "OverheidsEdits Tweets" xxx@xxx.de
