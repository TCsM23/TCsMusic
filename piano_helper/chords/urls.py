from django.urls import path

from . import views

app_name = "chords"

urlpatterns = [ 
    path("", views.home, name="home"),
    path("assistant/", views.assistant, name="assistant"),   
    path("learn/", views.learn, name="learn"),          
    path("practice/", views.practice, name="practice"),   
    path("notation/", views.notation_page, name="notation"), 
    path("scales/", views.scales, name="scales"),
    path("songs/", views.songs, name="songs"),
    path("studio/", views.studio, name="studio"),
    path("about/", views.about, name="about"),
    path("api/identify/", views.api_identify, name="api-identify"),              
    path("api/key/", views.api_key, name="api-key"),
    path("api/chord/", views.api_chord, name="api-chord"),
    path("api/scale/", views.api_scale, name="api-scale"),
    path("api/progression/", views.api_progression, name="api-progression"),
]                                                  