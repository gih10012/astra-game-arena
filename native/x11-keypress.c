#include <X11/Xlib.h>
#include <X11/extensions/XTest.h>
#include <X11/keysym.h>
#include <errno.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static void sleep_milliseconds(long milliseconds) {
  struct timespec delay = {
      .tv_sec = milliseconds / 1000,
      .tv_nsec = (milliseconds % 1000) * 1000000,
  };
  while (nanosleep(&delay, &delay) != 0 && errno == EINTR) {
  }
}

static int parse_long(const char *value, long *result) {
  char *end = NULL;
  errno = 0;
  const long parsed = strtol(value, &end, 0);
  if (errno != 0 || end == value || *end != '\0') return 0;
  *result = parsed;
  return 1;
}

static int press_symbol(Display *display, KeySym symbol, long hold_ms,
                        int with_shift) {
  const KeyCode code = symbol == NoSymbol ? 0 : XKeysymToKeycode(display, symbol);
  const KeyCode shift = XKeysymToKeycode(display, XK_Shift_L);
  if (code == 0 || (with_shift && shift == 0)) return 0;
  if (with_shift) XTestFakeKeyEvent(display, shift, True, CurrentTime);
  XTestFakeKeyEvent(display, code, True, CurrentTime);
  XFlush(display);
  sleep_milliseconds(hold_ms);
  XTestFakeKeyEvent(display, code, False, CurrentTime);
  if (with_shift) XTestFakeKeyEvent(display, shift, False, CurrentTime);
  XFlush(display);
  return 1;
}

static int press_named(Display *display, const char *name, long hold_ms) {
  return press_symbol(display, XStringToKeysym(name), hold_ms, 0);
}

static int ascii_symbol(unsigned char value, KeySym *symbol, int *shift) {
  *shift = 0;
  if (value >= 'a' && value <= 'z') { *symbol = XK_a + value - 'a'; return 1; }
  if (value >= 'A' && value <= 'Z') { *symbol = XK_a + value - 'A'; *shift = 1; return 1; }
  if (value >= '0' && value <= '9') { *symbol = XK_0 + value - '0'; return 1; }
  switch (value) {
    case ' ': *symbol = XK_space; return 1;
    case '\n': *symbol = XK_Return; return 1;
    case '\t': *symbol = XK_Tab; return 1;
    case '-': *symbol = XK_minus; return 1;
    case '_': *symbol = XK_minus; *shift = 1; return 1;
    case '=': *symbol = XK_equal; return 1;
    case '+': *symbol = XK_equal; *shift = 1; return 1;
    case '[': *symbol = XK_bracketleft; return 1;
    case '{': *symbol = XK_bracketleft; *shift = 1; return 1;
    case ']': *symbol = XK_bracketright; return 1;
    case '}': *symbol = XK_bracketright; *shift = 1; return 1;
    case '\\': *symbol = XK_backslash; return 1;
    case '|': *symbol = XK_backslash; *shift = 1; return 1;
    case ';': *symbol = XK_semicolon; return 1;
    case ':': *symbol = XK_semicolon; *shift = 1; return 1;
    case '\'': *symbol = XK_apostrophe; return 1;
    case '"': *symbol = XK_apostrophe; *shift = 1; return 1;
    case ',': *symbol = XK_comma; return 1;
    case '<': *symbol = XK_comma; *shift = 1; return 1;
    case '.': *symbol = XK_period; return 1;
    case '>': *symbol = XK_period; *shift = 1; return 1;
    case '/': *symbol = XK_slash; return 1;
    case '?': *symbol = XK_slash; *shift = 1; return 1;
    case '`': *symbol = XK_grave; return 1;
    case '~': *symbol = XK_grave; *shift = 1; return 1;
    case '!': *symbol = XK_1; *shift = 1; return 1;
    case '@': *symbol = XK_2; *shift = 1; return 1;
    case '#': *symbol = XK_3; *shift = 1; return 1;
    case '$': *symbol = XK_4; *shift = 1; return 1;
    case '%': *symbol = XK_5; *shift = 1; return 1;
    case '^': *symbol = XK_6; *shift = 1; return 1;
    case '&': *symbol = XK_7; *shift = 1; return 1;
    case '*': *symbol = XK_8; *shift = 1; return 1;
    case '(': *symbol = XK_9; *shift = 1; return 1;
    case ')': *symbol = XK_0; *shift = 1; return 1;
    default: return 0;
  }
}

static int legacy_sequence(Display *display, int argc, char **argv) {
  long interval_ms = 0, settle_ms = 0, hold_ms = 0;
  if (!parse_long(argv[3], &interval_ms) || interval_ms < 0 ||
      !parse_long(argv[4], &settle_ms) || settle_ms < 0 ||
      !parse_long(argv[5], &hold_ms) || hold_ms < 1) return 0;
  for (int index = 6; index < argc; index++) {
    if (!press_named(display, argv[index], hold_ms)) return 0;
    if (index + 1 < argc && interval_ms > 0) sleep_milliseconds(interval_ms);
  }
  if (settle_ms > 0) sleep_milliseconds(settle_ms);
  return 1;
}

int main(int argc, char **argv) {
  if (argc < 4) {
    fputs("usage: astra-x11-keypress DISPLAY WINDOW MODE [ARGS...]\n", stderr);
    return 2;
  }
  long window_value = 0;
  if (!parse_long(argv[2], &window_value) || window_value <= 0) return 2;
  Display *display = XOpenDisplay(argv[1]);
  if (display == NULL) return 1;
  const Window window = (Window)window_value;
  XRaiseWindow(display, window);
  XSetInputFocus(display, window, RevertToPointerRoot, CurrentTime);
  XSync(display, False);

  int ok = 0;
  long value1 = 0, value2 = 0, value3 = 0, value4 = 0, value5 = 0;
  if (parse_long(argv[3], &value1)) {
    ok = argc >= 7 && legacy_sequence(display, argc, argv);
  } else if (strcmp(argv[3], "move") == 0 && argc == 6 &&
             parse_long(argv[4], &value1) && parse_long(argv[5], &value2)) {
    ok = XTestFakeMotionEvent(display, DefaultScreen(display), (int)value1,
                              (int)value2, CurrentTime) != 0;
    XFlush(display);
  } else if (strcmp(argv[3], "click") == 0 && argc == 8 &&
             parse_long(argv[4], &value1) && parse_long(argv[5], &value2) &&
             parse_long(argv[6], &value3) && parse_long(argv[7], &value4)) {
    XTestFakeMotionEvent(display, DefaultScreen(display), (int)value1,
                         (int)value2, CurrentTime);
    ok = 1;
    for (long index = 0; index < value4; index++) {
      XTestFakeButtonEvent(display, (unsigned int)value3, True, CurrentTime);
      XTestFakeButtonEvent(display, (unsigned int)value3, False, CurrentTime);
      XFlush(display);
      if (index + 1 < value4) sleep_milliseconds(90);
    }
  } else if (strcmp(argv[3], "drag") == 0 && argc == 9 &&
             parse_long(argv[4], &value1) && parse_long(argv[5], &value2) &&
             parse_long(argv[6], &value3) && parse_long(argv[7], &value4) &&
             parse_long(argv[8], &value5)) {
    const int steps = value5 <= 0 ? 1 : (int)fmax(2, fmin(120, value5 / 16));
    XTestFakeMotionEvent(display, DefaultScreen(display), (int)value1, (int)value2, CurrentTime);
    XTestFakeButtonEvent(display, 1, True, CurrentTime);
    for (int index = 1; index <= steps; index++) {
      const int x = (int)(value1 + (value3 - value1) * index / steps);
      const int y = (int)(value2 + (value4 - value2) * index / steps);
      XTestFakeMotionEvent(display, DefaultScreen(display), x, y, CurrentTime);
      XFlush(display);
      if (value5 > 0) sleep_milliseconds(value5 / steps);
    }
    XTestFakeButtonEvent(display, 1, False, CurrentTime);
    XFlush(display);
    ok = 1;
  } else if (strcmp(argv[3], "scroll") == 0 && argc == 8 &&
             parse_long(argv[4], &value1) && parse_long(argv[5], &value2) &&
             parse_long(argv[6], &value3) && parse_long(argv[7], &value4)) {
    XTestFakeMotionEvent(display, DefaultScreen(display), (int)value1, (int)value2, CurrentTime);
    const unsigned int horizontal = value3 < 0 ? 6 : 7;
    const unsigned int vertical = value4 < 0 ? 4 : 5;
    ok = 1;
    for (long index = 0; index < labs(value3) && index < 100; index++) {
      XTestFakeButtonEvent(display, horizontal, True, CurrentTime);
      XTestFakeButtonEvent(display, horizontal, False, CurrentTime);
    }
    for (long index = 0; index < labs(value4) && index < 100; index++) {
      XTestFakeButtonEvent(display, vertical, True, CurrentTime);
      XTestFakeButtonEvent(display, vertical, False, CurrentTime);
    }
    XFlush(display);
  } else if (strcmp(argv[3], "type") == 0 && argc == 7 &&
             parse_long(argv[4], &value1) && parse_long(argv[5], &value2)) {
    ok = 1;
    const unsigned char *text = (const unsigned char *)argv[6];
    for (size_t index = 0; text[index] != '\0'; index++) {
      KeySym symbol = NoSymbol;
      int shift = 0;
      if (!ascii_symbol(text[index], &symbol, &shift) ||
          !press_symbol(display, symbol, 25, shift)) { ok = 0; break; }
      if (value1 > 0) sleep_milliseconds(value1);
    }
    if (ok && value2 > 0) sleep_milliseconds(value2);
  }

  if (!ok) fputs("astra-x11-keypress: invalid or unsupported action\n", stderr);
  XCloseDisplay(display);
  return ok ? 0 : 2;
}
