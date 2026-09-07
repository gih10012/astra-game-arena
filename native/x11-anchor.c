#include <X11/Xlib.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

static volatile sig_atomic_t running = 1;

static void stop(int signal_number) {
  (void)signal_number;
  running = 0;
}

int main(int argc, char **argv) {
  signal(SIGINT, stop);
  signal(SIGTERM, stop);
  Display *display = XOpenDisplay(NULL);
  if (display == NULL) {
    fputs("astra-x11-anchor: cannot open DISPLAY\n", stderr);
    return 1;
  }
  const int screen = DefaultScreen(display);
  const Window root = RootWindow(display, screen);
  const Window window = XCreateSimpleWindow(
      display, root, 0, 0, 1280, 1080, 0,
      BlackPixel(display, screen), BlackPixel(display, screen));
  XStoreName(display, window, "Astra Game Arena bootstrap");
  XSelectInput(display, window, ExposureMask | StructureNotifyMask);
  XMapWindow(display, window);
  XLowerWindow(display, window);
  XFlush(display);
  if (argc >= 2) {
    const char *wayland = getenv("WAYLAND_DISPLAY");
    const char *runtime = getenv("XDG_RUNTIME_DIR");
    FILE *output = fopen(argv[1], "w");
    if (output == NULL || wayland == NULL || runtime == NULL) {
      fputs("astra-x11-anchor: cannot write environment file\n", stderr);
      if (output != NULL) fclose(output);
      XDestroyWindow(display, window);
      XCloseDisplay(display);
      return 1;
    }
    fprintf(output,
            "{\n  \"DISPLAY\": \"%s\",\n  \"WAYLAND_DISPLAY\": \"%s\",\n"
            "  \"XDG_RUNTIME_DIR\": \"%s\"\n}\n",
            DisplayString(display), wayland, runtime);
    fclose(output);
  }
  const struct timespec interval = {.tv_sec = 0, .tv_nsec = 33000000};
  while (running) {
    while (XPending(display) > 0) {
      XEvent event;
      XNextEvent(display, &event);
    }
    XClearWindow(display, window);
    XFlush(display);
    nanosleep(&interval, NULL);
  }
  XDestroyWindow(display, window);
  XCloseDisplay(display);
  return 0;
}
