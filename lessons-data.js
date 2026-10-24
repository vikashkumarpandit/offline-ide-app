/* lessons-data.js — the course as plain text (typed from "Complete Python Course — A–Z Roadmap").
   `topics`  : the roadmap points of the lesson.
   `content` : OPTIONAL detailed lesson text. Paste it here when you have it; the lesson then shows it above the topics.
               Mini format:  "# Heading"  "## Sub-heading"  "- bullet"  "> note"  blank line = new paragraph
                             ``` on its own line starts / ends a code block.  `code` and **bold** work inside text. */
window.COURSE = {
  title: "Complete Python Course — A–Z Roadmap",
  howTo: {
    intro: "Study one lesson at a time. Read the explanation, type each example yourself in your Python IDE, predict the output before running it, and then modify the code. Do not move ahead until you can explain what the code does.",
    steps: [
      ["Learn", "Understand the concept and the syntax."],
      ["Type", "Write the example manually instead of only copying it."],
      ["Run", "Check the actual output in your IDE."],
      ["Experiment", "Change values and test edge cases."],
      ["Practice", "Solve small problems without looking at the answer."],
      ["Review", "Revisit older lessons regularly and build projects."]
    ],
    overview: "The 30 modules below are grouped from foundational knowledge to advanced and specialist topics. Some modules will take several sessions; the numbering is a roadmap, not a promise that every module takes the same amount of time."
  },
  parts: [
    "PART 1 — PYTHON FOUNDATIONS",
    "PART 2 — DECISIONS, LOOPS, AND LOGIC",
    "PART 3 — CORE DATA STRUCTURES",
    "PART 4 — FUNCTIONS AND REUSABLE CODE",
    "PART 5 — OBJECT-ORIENTED PROGRAMMING",
    "PART 6 — FILES, ERRORS, AND DATA",
    "PART 7 — ADVANCED PYTHON",
    "PART 8 — STANDARD LIBRARY AND PROFESSIONAL PRACTICE",
    "PART 9 — APPLICATION AREAS",
    "PART 10 — PROJECTS AND MASTERY"
  ],
  lessons: [
    { n: 1, part: 1, title: "Introduction to Python", content: "", topics: [
      "What Python is, its history, common uses, strengths, and limitations.",
      "Interpreter, compiler, IDE, editor, terminal, and interactive REPL.",
      "Installing or accessing Python; running your first program.",
      "Using `print()` and understanding program output."] },
    { n: 2, part: 1, title: "Syntax and Indentation", content: "", topics: [
      "Statements, expressions, code blocks, indentation, comments, keywords, and identifiers.",
      "Naming conventions, readable code, and PEP 8 style guidelines."] },
    { n: 3, part: 1, title: "Variables and Data Types", content: "", topics: [
      "Assignment, names, multiple assignment, and dynamic typing.",
      "`int`, `float`, `complex`, `str`, `bool`, and `None`.",
      "The `type()` and `id()` functions; type conversion; mutable and immutable objects."] },
    { n: 4, part: 1, title: "Input and Output", content: "", topics: [
      "`input()`, `print()`, `sep`, and `end`.",
      "Converting input with `int()`, `float()`, and `str()`.",
      "Formatted strings (f-strings), formatting values, and validating user input."] },
    { n: 5, part: 1, title: "Operators", content: "", topics: [
      "Arithmetic, comparison, assignment, logical, and bitwise operators.",
      "Membership operators (`in`, `not in`) and identity operators (`is`, `is not`).",
      "Operator precedence, associativity, and short-circuit evaluation."] },

    { n: 6, part: 2, title: "Decision Making", content: "", topics: [
      "`if`, `elif`, `else`, nested conditions, and conditional expressions.",
      "Truthy and falsy values, `match-case`, and logical conditions."] },
    { n: 7, part: 2, title: "Loops", content: "", topics: [
      "`for`, `while`, `range()`, nested loops, and loop control.",
      "`break`, `continue`, `pass`, loop `else`, and avoiding unintended infinite loops."] },
    { n: 8, part: 2, title: "Problem-Solving Logic", content: "", topics: [
      "Algorithms, flowcharts, pseudocode, dry runs, trace tables, counters, and accumulators.",
      "Pattern printing, prime numbers, factorial, Fibonacci, and an introduction to time complexity."] },

    { n: 9, part: 3, title: "Strings", content: "", topics: [
      "Creation, indexing, negative indexing, slicing, immutability, and escape sequences.",
      "Common methods: `split()`, `join()`, `replace()`, `find()`, `count()`, `strip()`, `lower()`, and `upper()`.",
      "String formatting, Unicode, and character encoding."] },
    { n: 10, part: 3, title: "Lists", content: "", topics: [
      "Creation, indexing, slicing, nested lists, and 2D lists.",
      "`append()`, `extend()`, `insert()`, `remove()`, `pop()`, `sort()`, `reverse()`, and `copy()`.",
      "Aliasing, shallow copies, list comprehensions, and matrix operations."] },
    { n: 11, part: 3, title: "Tuples", content: "", topics: [
      "Creation, indexing, slicing, packing, unpacking, single-element tuples, immutability, and tuple methods.",
      "Choosing between tuples and lists."] },
    { n: 12, part: 3, title: "Sets", content: "", topics: [
      "Set creation, unique elements, and set operations.",
      "`add()`, `update()`, `remove()`, `discard()`, union, intersection, difference, subsets, and supersets.",
      "Set comprehensions and `frozenset`."] },
    { n: 13, part: 3, title: "Dictionaries", content: "", topics: [
      "Key-value pairs, lookup, iteration, nested dictionaries, and hashable keys.",
      "`get()`, `keys()`, `values()`, `items()`, `update()`, `pop()`, and `setdefault()`.",
      "Dictionary comprehensions and common use cases."] },

    { n: 14, part: 4, title: "Functions", content: "", topics: [
      "`def`, `return`, parameters, arguments, positional and keyword arguments, and default parameters.",
      "`*args`, `**kwargs`, local/global scope, `global`, `nonlocal`, docstrings, lambda functions, and recursion."] },
    { n: 15, part: 4, title: "Advanced Function Concepts", content: "", topics: [
      "First-class and higher-order functions, closures, decorators, generators, and `yield`.",
      "`map()`, `filter()`, `zip()`, `enumerate()`, `any()`, `all()`, and an introduction to `functools` and `itertools`."] },
    { n: 16, part: 4, title: "Modules and Packages", content: "", topics: [
      "Import statements, aliases, modules, packages, and `__init__.py`.",
      "`if __name__ == '__main__'`, the standard library, `pip`, virtual environments, dependency management, and `requirements.txt`."] },

    { n: 17, part: 5, title: "OOP Foundations", content: "", topics: [
      "Classes, objects, attributes, methods, `__init__()`, and `self`.",
      "Instance and class variables; instance, class, and static methods; encapsulation and properties."] },
    { n: 18, part: 5, title: "Advanced OOP", content: "", topics: [
      "Inheritance, multiple and multilevel inheritance, overriding, `super()`, and polymorphism.",
      "Abstract classes, the `abc` module, composition, aggregation, and method resolution order (MRO)."] },
    { n: 19, part: 5, title: "Python Data Model", content: "", topics: [
      "Dunder methods such as `__str__()`, `__repr__()`, `__len__()`, and comparison methods.",
      "Operator overloading, iterators, custom containers, `dataclasses`, and an introduction to `__slots__`."] },

    { n: 20, part: 6, title: "File Handling", content: "", topics: [
      "`open()`, file modes, reading and writing, and the `with` statement.",
      "Text and binary files, paths with `pathlib`, directory operations, CSV, and JSON."] },
    { n: 21, part: 6, title: "Exception Handling", content: "", topics: [
      "Syntax errors, runtime errors, tracebacks, and `try`/`except`/`else`/`finally`.",
      "Raising and defining exceptions, exception chaining, `assert`, and debugging."] },
    { n: 22, part: 6, title: "Data Formats and Serialization", content: "", topics: [
      "JSON encoding and decoding, CSV reading and writing, bytes and bytearray, UTF-8, dates and times, and regular expressions with `re`.",
      "Pickle and why untrusted pickle files must not be loaded; data validation."] },

    { n: 23, part: 7, title: "Advanced Language Features", content: "", topics: [
      "Comprehensions, generator expressions, iterators, generators, context managers, and `contextlib`.",
      "Advanced decorators, type hints, the `typing` module, pattern matching, and unpacking."] },
    { n: 24, part: 7, title: "Memory and Performance", content: "", topics: [
      "References, object identity, mutability, shallow and deep copies, and garbage collection.",
      "Big-O notation, profiling, benchmarking, `timeit`, `cProfile`, and `tracemalloc`."] },
    { n: 25, part: 7, title: "Concurrency and Asynchronous Programming", content: "", topics: [
      "Processes, threads, locks, synchronization, race conditions, and `concurrent.futures`.",
      "`async`/`await`, `asyncio`, async iterators, async context managers, and the version-dependent role of the GIL."] },

    { n: 26, part: 8, title: "Standard Library Survey", content: "", topics: [
      "Numbers and statistics: `math`, `statistics`, `random`, `decimal`, and `fractions`.",
      "Time and files: `datetime`, `time`, `calendar`, `os`, `sys`, `pathlib`, `shutil`, `glob`, and `tempfile`.",
      "Collections and tools: `collections`, `itertools`, `functools`, `re`, `textwrap`, `logging`, and `argparse`.",
      "Data, networking, and security: `json`, `csv`, `sqlite3`, `subprocess`, `hashlib`, `secrets`, `socket`, `http`, and `urllib`.",
      "Testing and communication: `unittest`, `doctest`, `email`, and `smtplib`."] },
    { n: 27, part: 8, title: "Testing and Software Engineering", content: "", topics: [
      "Unit and integration testing, `unittest`, `pytest`, fixtures, mocking, and debugging.",
      "Logging, Git, GitHub, code review, refactoring, PEP 8, documentation, type checking, linters, formatters, and CI/CD basics."] },

    { n: 28, part: 9, title: "Building Different Kinds of Software", content: "", topics: [
      "Desktop GUI: `tkinter`, widgets, events, layouts, PySide/PyQt, and packaging.",
      "Web development: HTTP, Flask, Django, FastAPI, REST APIs, authentication, sessions, databases, and ORM.",
      "Data analysis: NumPy, Pandas, Matplotlib, data cleaning, spreadsheets, and basic statistics.",
      "Games: Pygame, game loops, events, collision detection, sprites, animation, sound, and scoring."] },
    { n: 29, part: 9, title: "Specialist Fields", content: "", topics: [
      "Automation and scripting; web scraping and HTML parsing; networking and API clients.",
      "Database programming with SQLite and PostgreSQL; scientific computing; machine learning and deep learning; computer vision.",
      "Defensive cybersecurity, robotics and hardware integration, cloud deployment, packaging, and distribution.",
      "These are separate specializations; you do not need to master every field to become proficient in core Python."] },

    { n: 30, part: 10, title: "Project Ladder", content: "", topics: [
      "Beginner: calculator, number guessing game, and pattern-printing programs.",
      "Intermediate: student management system, quiz application, expense tracker, and file manager.",
      "Advanced: a Python code tester with safe subprocess handling and timeouts, a desktop IDE, and a REST API application.",
      "Capstone: choose one project, add tests, error handling, documentation, version control, and packaging."] }
  ]
};
