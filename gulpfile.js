var gulp        = require('gulp');
var source      = require('vinyl-source-stream');
var gutil       = require('gulp-util');
var coffee      = require('gulp-coffee');

// simple transpile if you want to bundle it yourself
// using this can reduce the size of your own bundle
gulp.task("transpile", function(){
  gulp.src('./lib/**/*.coffee')
    .pipe(coffee({bare: true}).on('error', gutil.log))
    .pipe(gulp.dest('./lib-js/'))
});

gulp.task("build", ["transpile"]);

gulp.task("default", ["build"]);
